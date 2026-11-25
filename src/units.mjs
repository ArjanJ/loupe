// Folds a package's files into at most `maxUnits` "units" (folders, parts of folders, single files), so the planning
// prompt and its answer stay the same size whether a package has 50 files or 50,000. The model groups unit ids into
// modules; the code then assigns every file through its unit.
//   buildUnits(paths, { base, maxUnits }) -> [{ id, kind, dir, label, files }]
//   kind: file (one file), dir (a folder and everything under it), flat (only the files directly in dir),
//         prefix (files in dir whose names start the same), chunk (an alphabetical slice of a flat folder),
//         rest (the smaller subfolders of dir that did not get a unit of their own)
import { posix } from 'node:path';

const CHUNK_TARGET = 20; // files per alphabetical slice of a big flat folder

const below = (dir, f) => (dir ? f.slice(dir.length + 1) : f);
const prefixOf = (f) => posix.basename(f).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).find(Boolean) || '';

function chunks(u, budget) {
  const k = Math.max(2, Math.min(budget, Math.ceil(u.files.length / CHUNK_TARGET)));
  if (k > budget) return null;
  const sorted = [...u.files].sort(), size = Math.ceil(sorted.length / k), out = [];
  for (let i = 0; i < sorted.length; i += size) out.push({ kind: 'chunk', dir: u.dir, files: sorted.slice(i, i + size), done: true });
  return out.length > 1 ? out : null;
}

function splitFlat(u, budget) {
  if (u.kind === 'flat') {
    const groups = new Map();
    for (const f of u.files) { const p = prefixOf(f); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(f); }
    // the label shows the prefix as the first file spells it (UserCard.tsx -> User*), the grouping ignores case
    const big = [...groups].filter(([, fs]) => fs.length > 1).sort((a, b) => b[1].length - a[1].length);
    const singles = [...groups].filter(([, fs]) => fs.length === 1).flatMap(([, fs]) => fs);
    const parts = big.map(([prefix, fs]) => ({ kind: 'prefix', dir: u.dir, prefix: posix.basename(fs[0]).slice(0, prefix.length), files: fs }));
    if (singles.length) parts.push({ kind: 'chunk', dir: u.dir, files: singles, done: singles.length <= CHUNK_TARGET });
    // useful only when it really divides the folder and fits the budget
    if (parts.length > 1 && parts.length <= budget && big[0][1].length < u.files.length * 0.9) return parts;
  }
  return chunks(u, budget);
}

function split(u, budget) {
  if (u.kind !== 'dir') return splitFlat(u, budget);
  const direct = [], subs = new Map();
  for (const f of u.files) {
    const r = below(u.dir, f), i = r.indexOf('/');
    if (i < 0) direct.push(f);
    else { const seg = r.slice(0, i); if (!subs.has(seg)) subs.set(seg, []); subs.get(seg).push(f); }
  }
  // a folder holding one subfolder and nothing else: step down, same files
  if (!direct.length && subs.size === 1) { const [[seg, fs]] = subs; return [{ kind: 'dir', dir: posix.join(u.dir, seg), files: fs }]; }
  if (!subs.size) return splitFlat({ ...u, kind: 'flat' }, budget);
  let parts = [...subs].map(([seg, fs]) => ({ kind: 'dir', dir: u.dir ? posix.join(u.dir, seg) : seg, files: fs })).sort((a, b) => b.files.length - a.files.length);
  const flat = direct.length ? [{ kind: 'flat', dir: u.dir, files: direct }] : [];
  if (parts.length + flat.length > budget) {
    // too many subfolders: the biggest half of the budget keep a unit each, the rest share alphabetical runs of
    // subfolders with about the same number of files in each run
    const slots = Math.max(1, budget - flat.length);
    const keep = Math.floor(slots / 2), runs = slots - keep;
    const rest = parts.slice(keep).sort((a, b) => a.dir.localeCompare(b.dir));
    const total = rest.reduce((a, p) => a + p.files.length, 0), per = total / runs, out = [];
    let cur = null;
    for (const p of rest) {
      if (!cur || (cur.files.length >= per && out.length < runs)) { cur = { kind: 'rest', dir: u.dir, names: [], files: [], done: true }; out.push(cur); }
      cur.names.push(posix.basename(p.dir)); cur.files.push(...p.files);
    }
    parts = [...parts.slice(0, keep), ...out];
  }
  return [...parts, ...flat];
}

function label(u) {
  const at = u.dir ? `${u.dir}/` : './';
  if (u.kind === 'file') return u.files[0];
  if (u.kind === 'dir') return at;
  if (u.kind === 'flat') return `${at} (files directly in this folder)`;
  if (u.kind === 'prefix') return `${at}${u.prefix}*`;
  if (u.kind === 'rest') return `${at}{${u.names.slice(0, 6).join(',')}${u.names.length > 6 ? `,+${u.names.length - 6} more` : ''}}/`;
  const names = u.files.map((f) => posix.basename(f)).sort();
  return `${at} (files ${names[0]} … ${names[names.length - 1]})`;
}

export function buildUnits(paths, { base = '.', maxUnits = 60 } = {}) {
  maxUnits = Math.max(2, maxUnits);
  let units;
  if (paths.length <= maxUnits) units = paths.map((f) => { const d = posix.dirname(f); return { kind: 'file', dir: d === '.' ? '' : d, files: [f] }; });
  else {
    units = [{ kind: 'dir', dir: base === '.' ? '' : base, files: [...paths] }];
    // split the biggest unit until the budget is spent or nothing more divides
    for (let guard = 0; units.length < maxUnits && guard < 10_000; guard++) {
      const cand = units.filter((u) => !u.done && u.files.length > 1).sort((a, b) => b.files.length - a.files.length)[0];
      if (!cand) break;
      const parts = split(cand, maxUnits - units.length + 1);
      if (!parts) { cand.done = true; continue; }
      units.splice(units.indexOf(cand), 1, ...parts);
    }
  }
  units.sort((a, b) => (a.dir === b.dir ? a.files[0].localeCompare(b.files[0]) : a.dir.localeCompare(b.dir)));
  return units.map((u, i) => ({ id: `u${i + 1}`, kind: u.kind, dir: u.dir, label: label(u), files: u.files }));
}

// Modules without the model: units grouped by folder, at the deepest folder level that still gives at most maxMods
// groups (the biggest maxMods - 1 and "Other" when even the top level has too many).
export function fallbackModules(units, { base = '.', maxMods = 9 } = {}) {
  const rel = (u) => (base === '.' ? u.dir : u.dir === base ? '' : below(base, u.dir));
  const groupAt = (depth) => {
    const groups = new Map();
    for (const u of units) {
      const key = rel(u).split('/').filter(Boolean).slice(0, depth).join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(...u.files);
    }
    return groups;
  };
  let groups = groupAt(1);
  for (let d = 2; d <= 8; d++) { const g = groupAt(d); if (g.size > maxMods) break; if (g.size > groups.size) groups = g; }
  const title = (s) => s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  if (groups.size === 1 && units.length > 1) {
    // one folder holds everything: cut the (folder-sorted) units into runs of about the same size instead
    const [[dir]] = groups, n = Math.min(maxMods, units.length), per = units.reduce((a, u) => a + u.files.length, 0) / n, mods = [];
    let cur = null;
    for (const u of units) {
      if (!cur || (cur.files.length >= per && mods.length < n)) { cur = { key: `${dir || 'root'}-${mods.length + 1}`, label: `${dir ? title(posix.basename(dir)) : 'Files'} ${mods.length + 1}`, shortDescription: '', longDescription: '', files: [] }; mods.push(cur); }
      cur.files.push(...u.files);
    }
    for (const m of mods) m.shortDescription = `Part ${m.label.split(' ').pop()} of ${dir || 'the package root'}.`;
    return mods;
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  const keep = sorted.length > maxMods ? sorted.slice(0, maxMods - 1) : sorted;
  const rest = sorted.slice(keep.length).flatMap(([, fs]) => fs);
  const mods = keep.map(([dir, fs]) => ({ key: dir || 'root', label: dir ? title(posix.basename(dir)) : 'Root Files', shortDescription: `Files in ${dir || 'the package root'}.`, longDescription: '', files: fs }));
  if (rest.length) mods.push({ key: 'other', label: 'Other', shortDescription: 'Files in the remaining folders.', longDescription: '', files: rest });
  return mods;
}
