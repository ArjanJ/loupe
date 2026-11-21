#!/usr/bin/env node
// System manifest (YAML) -> Loupe zoom tree.
// Usage: loupe manifest <manifest.yaml> [out.json] [--strict]   (or node src/manifest.mjs ...)
// A manifest describes a system that spans many repos: services, datastores, external systems, shared libraries,
// typed calls between them and end-to-end flows, each with a lifecycle status and an optional confidence.
// See docs/manifest.md for the schema. Every relation keeps the manifest line it came from as its evidence.
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { parseDocument, LineCounter, isMap, isSeq } from 'yaml';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const [inPath, outArg] = args.filter((a) => !a.startsWith('--'));
if (!inPath) { console.error('usage: loupe manifest <manifest.yaml> [out.json] [--strict]'); process.exit(2); }
const MANIFEST = resolve(inPath);
const OUT = resolve(outArg || MANIFEST.replace(/\.ya?ml$/i, '') + '.tree.json');
const SRC = basename(MANIFEST); // evidence shows the file name only, never an absolute path

const lc = new LineCounter();
const doc = parseDocument(readFileSync(MANIFEST, 'utf8'), { lineCounter: lc, uniqueKeys: false });
if (doc.errors.length) { for (const e of doc.errors) console.error(`${SRC}: ${e.message}`); process.exit(1); }
const M = doc.toJS({ maxAliasCount: 50 }) || {};
const errors = [], warnings = [];
const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
const lineOf = (path) => { const n = doc.getIn(path, true); return n && n.range ? lc.linePos(n.range[0]).line : 0; };

// ---------------------------------------------------------------- helpers
const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const slug = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
// labels come from ids ("uber-direct" -> "Uber Direct"); a word keeps the casing the manifest's own prose uses
// most ("api" -> "API", "github" -> "GitHub"), so no per-item name is needed
const CASING = new Map();
{
  const counts = new Map(); // ENV_VAR_NAMES are skipped: they would shout every label
  (function walk(v) {
    if (typeof v === 'string') { for (const w of v.match(/[A-Za-z0-9_]+/g) || []) if (/^[A-Za-z][A-Za-z0-9]*$/.test(w) && w !== w.toLowerCase()) { const k = w.toLowerCase(), m = counts.get(k) || new Map(); m.set(w, (m.get(w) || 0) + 1); counts.set(k, m); } }
    else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(M);
  for (const [k, m] of counts) CASING.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
}
const ACRONYM = /^(api|ui|db|sdk|spa|cli|ci|aws|s3|sqs|sns|rpc|grpc|sso|url|sms)$/i;
function prettify(id) {
  return str(id).split(/[-_\s]+/).filter(Boolean).map((w) => { const k = w.toLowerCase(), c = CASING.get(k); if (c) return c; return ACRONYM.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1); }).join(' ');
}
function sentences(text) {
  const t = str(text).replace(/\s+/g, ' ');
  if (!t) return ['', ''];
  const m = t.match(/^(.{20,220}?[.!?])(\s+|$)(.*)$/);
  if (!m) return t.length > 160 ? [t.slice(0, t.lastIndexOf(' ', 150)) + '…', t] : [t, ''];
  return [m[1], m[3]];
}
// "Orders and shipments (draft 3); today mocked" -> "Orders and shipments"
function shortLabel(what, max = 46) {
  let t = str(what).replace(/\s+/g, ' ').split(/;|\s\(|\s—\s|\s-\s|: /)[0].trim();
  if (t.length > max) { const cut = t.lastIndexOf(' ', max - 1); t = t.slice(0, cut > 20 ? cut : max - 1) + '…'; }
  return t.charAt(0).toLowerCase() === t.charAt(0) ? t : (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
}
// lifecycle: built | branch | proposed | planned. Accepts the bare word, a sentence that starts with one
// ("built (health only) + branch"), or { state, note }. The full text is kept as the note.
const STATUS_WORDS = [
  [/^(built|deployed|live|shipped|done|production|prod)\b/, 'built'],
  [/^(branch|open[- ]branch|open pr|pr|in review|wip|in progress)\b/, 'branch'],
  [/^(proposed|rfc|design|draft|dev[- ]only|spike)\b/, 'proposed'],
  [/^(planned|agreed|todo|future|not started)\b/, 'planned'],
];
function status(v, where) {
  if (v && typeof v === 'object' && !Array.isArray(v)) { const s = status(v.state ?? v.status, where); return { status: s.status, note: str(v.note) || s.note }; }
  const raw = str(v);
  if (!raw) return { status: '', note: '' };
  const low = raw.toLowerCase();
  for (const [re, s] of STATUS_WORDS) if (re.test(low)) return { status: s, note: low === s ? '' : raw };
  // "partly built", "client mocked; billing API proposed": first lifecycle word anywhere
  const any = low.match(/\b(built|deployed|branch|proposed|planned)\b/);
  if (any) return { status: STATUS_WORDS.find(([re]) => re.test(any[1]))[1], note: raw };
  warn(`${where}: status "${raw}" has no lifecycle word (built, branch, proposed, planned); shown as a note only`);
  return { status: '', note: raw };
}
// lenient: "Orders (proposed contract draft.17)" -> proposed, when no explicit status is given
const parenStatus = (text) => { const m = str(text).match(/\((built|branch|proposed|planned)\b[^)]*\)/i); return m ? m[1].toLowerCase() : ''; };
const RANK = { '': 0, built: 0, branch: 1, proposed: 2, planned: 3 };
const conf = (o) => (o && str(o.confidence).toLowerCase() === 'low' ? 'low' : '');
function withStatus(node, src, where) {
  const s = status(src.status, where);
  if (s.status) node.status = s.status;
  if (s.note) node.statusNote = s.note;
  if (conf(src)) node.confidence = 'low';
  return node;
}

// ---------------------------------------------------------------- nodes
const byRaw = new Map(); // manifest id -> tree node
const grafted = [], graftedRollups = {}, graftedFlows = []; // relations + rollups from per-repo trees (drill-down)
const nodeIds = new Set();
function claim(raw, node, where) {
  if (!raw) { err(`${where}: missing id`); return false; }
  if (byRaw.has(raw)) { err(`${where}: duplicate id "${raw}"`); return false; }
  if (nodeIds.has(node.id)) { err(`${where}: duplicate node id "${node.id}"`); return false; }
  byRaw.set(raw, node); nodeIds.add(node.id); return true;
}
const leaf = (o) => ({ children: [], edges: [], ...o });

const sys = M.system && typeof M.system === 'object' ? M.system : {};
if (!str(sys.name)) err('system.name is required');
const repos = arr(M.repos).filter((r) => typeof r === 'object');
const repoBy = new Map();
repos.forEach((r, i) => { const n = str(r.name); if (!n) err(`repos[${i}]: missing name`); else if (repoBy.has(n)) err(`repos[${i}]: duplicate repo "${n}"`); else repoBy.set(n, { ...r, index: i, services: [] }); });

// services (+ their interfaces, or a grafted per-repo tree)
const services = arr(M.services).filter((s) => typeof s === 'object');
const svcNodes = [];
services.forEach((s, i) => {
  const where = `services[${i}]`, raw = str(s.id);
  const [short, long] = sentences(s.description);
  const node = withStatus(leaf({ id: `svc:${slug(raw)}`, label: str(s.name) || prettify(raw), kind: 'service', path: str(s.repo) || str(s.kind),
    shortDescription: short, longDescription: [long, str(s.runsAs) && `Runs as: ${str(s.runsAs)}.`].filter(Boolean).join(' ').replace(/\.\.$/, '.'),
    serviceKind: str(s.kind), weight: 0 }), s, where);
  if (!claim(raw, node, where)) return;
  const exposes = arr(s.exposes).filter((e) => typeof e === 'object');
  const tree = str(s.tree) && graft(s.tree, node, where);
  if (tree) node.children = tree;
  else node.children = exposes.map((e, j) => {
    const st = e.status ? status(e.status, `${where}.exposes[${j}]`) : { status: parenStatus(e.description), note: '' };
    const c = leaf({ id: `${node.id}#${j}`, label: str(e.name) || `Interface ${j + 1}`, kind: 'endpoint', path: str(e.type) || 'interface',
      shortDescription: str(e.description), longDescription: '', weight: 10 });
    if (st.status) c.status = st.status; if (st.note) c.statusNote = st.note; if (conf(e)) c.confidence = 'low';
    return c;
  });
  if (tree && exposes.length) node.functions = exposes.map((e) => str(e.name)).filter(Boolean).slice(0, 8);
  node.weight = 40 + 12 * exposes.length + 8 * arr(s.calls).length + (tree ? tree.reduce((a, c) => a + (+c.weight > 0 ? Math.sqrt(+c.weight) : 0), 0) : 0);
  const repo = repoBy.get(str(s.repo));
  if (str(s.repo) && !repo) warn(`${where}: repo "${str(s.repo)}" is not listed under repos`);
  if (repo) repo.services.push(node); else svcNodes.push(node);
});

// datastores, externals, shared libraries
const dsNodes = arr(M.datastores).filter((d) => typeof d === 'object').map((d, i) => {
  const where = `datastores[${i}]`, raw = str(d.id), [short, long] = sentences(d.description);
  const node = withStatus(leaf({ id: `ds:${slug(raw)}`, label: str(d.name) || prettify(raw), kind: 'datastore', path: str(d.kind),
    shortDescription: short || str(d.kind), longDescription: long, weight: 30 }), d, where);
  return claim(raw, node, where) ? node : null;
}).filter(Boolean);
const extNodes = arr(M.external).filter((d) => typeof d === 'object').map((d, i) => {
  const where = `external[${i}]`, raw = str(d.id), [short, long] = sentences(d.description);
  const node = withStatus(leaf({ id: `ext:${slug(raw)}`, label: str(d.name) || prettify(raw), kind: 'external', path: 'external system',
    shortDescription: short, longDescription: long, weight: 18 }), d, where);
  return claim(raw, node, where) ? node : null;
}).filter(Boolean);
const libRepos = new Set();
const libNodes = arr(M.sharedLibs).filter((d) => typeof d === 'object').map((d, i) => {
  const where = `sharedLibs[${i}]`, name = str(d.name), raw = str(d.id) || name;
  // a library repo with no services folds into its library card (by `repo`, or by name)
  const repo = repoBy.get(str(d.repo)) || [...repoBy.values()].find((r) => !r.services.length && /library|lib|package/i.test(str(r.role)) && name.toLowerCase().includes(basename(str(r.name)).toLowerCase()));
  if (repo) libRepos.add(repo.name);
  const [short, long] = sentences(d.description || repo?.description);
  const node = withStatus(leaf({ id: `lib:${slug(raw)}`, label: name || prettify(raw), kind: 'library', path: repo ? repo.name : 'shared library',
    shortDescription: short || '', longDescription: long, weight: 16 }), d, where);
  node._usedBy = arr(d.usedBy).map((u) => str(typeof u === 'object' ? u.service : u));
  return claim(raw, node, where) ? node : null;
}).filter(Boolean);

for (const l of libNodes) { const us = (l._usedBy || []).map((u) => byRaw.get(u)?.label).filter(Boolean); if (!l.shortDescription) l.shortDescription = us.length ? `Used by ${us.length > 2 ? us.slice(0, -1).join(', ') + ' and ' + us.at(-1) : us.join(' and ')}.` : 'Shared library.'; delete l._usedBy; }
// ---------------------------------------------------------------- top level: repos with several services group them
const tops = [];
for (const r of repoBy.values()) {
  const [short, long] = sentences(r.description);
  if (r.services.length > 1) {
    const g = withStatus({ id: `repo:${slug(r.name)}`, label: str(r.label) || basename(r.name), kind: 'repo', path: r.name, shortDescription: short, longDescription: long,
      weight: r.services.reduce((a, s) => a + s.weight, 0), children: r.services, edges: [] }, r, `repos[${r.index}]`);
    tops.push(g);
  } else if (r.services.length === 1) {
    const s = r.services[0];
    if (!s.longDescription && long) s.longDescription = long;
    tops.push(s);
  }
}
tops.push(...svcNodes);
const otherRepos = [...repoBy.values()].filter((r) => !r.services.length && !libRepos.has(r.name)).map((r) => {
  const [short, long] = sentences(r.description);
  return withStatus(leaf({ id: `repo:${slug(r.name)}`, label: str(r.label) || basename(r.name), kind: 'repo', path: str(r.role) || r.name,
    shortDescription: short, longDescription: [long, str(r.runsAs) && `Runs as: ${str(r.runsAs)}.`].filter(Boolean).join(' '), weight: 14 }), r, `repos[${r.index}]`);
});
const group = (id, label, kind, children, desc, extra = {}) => children.length ? [{ id, label, kind: 'group', path: kind, shortDescription: desc, longDescription: '',
  weight: children.reduce((a, c) => a + c.weight, 0), children, edges: [], ...extra }] : [];
tops.push(...group('grp:datastores', 'Datastores', 'data', dsNodes, 'Databases, caches and buckets the services read and write.'));
tops.push(...group('grp:libraries', 'Shared libraries', 'code', libNodes, 'Code and contracts shared between repos.'));
tops.push(...group('grp:repos', 'Other repos', 'repos', otherRepos, 'Repos with no service of their own: infrastructure, apps, tooling.'));
tops.push(...group('pkg:external', 'External systems', 'outside the system', extNodes, 'Third-party systems the services call or hear from.', { external: true }));

const rootS = status(sys.status, 'system');
const [rshort, rlong] = sentences(sys.description);
const root = { id: 'system', label: str(sys.name) || 'System', kind: 'system', path: str(sys.path) || 'system manifest', shortDescription: rshort, longDescription: rlong,
  weight: tops.reduce((a, c) => a + c.weight, 0), children: tops, edges: [] };
if (rootS.note || rootS.status) root.statusNote = rootS.note || rootS.status;

// ---------------------------------------------------------------- relations
const KIND_OF = [
  [/^(http|https|rest|grpc|graphql|gql|rpc|websocket|ws|sse|api)$/, 'http'],
  [/^(queue|event|events|bus|pubsub|pub\/sub|stream|topic|kafka|sqs|sns|async|message|messages)$/, 'queue'],
  [/^(webhook|webhooks|callback)$/, 'webhook'],
  [/^(db|database|sql|cache|storage|store|read|write|s3|blob)$/, 'db'],
  [/^(sdk|external)$/, 'external'],
  [/^(import|lib|library|code|package|npm)$/, 'import'],
  [/^(sandbox|exec)$/, 'sandbox'],
];
function kindFor(via, target, where) {
  const v = str(via).toLowerCase();
  let k = (KIND_OF.find(([re]) => re.test(v)) || [])[1];
  if (!k) { if (v) warn(`${where}: unknown via "${v}", drawn as http`); k = 'http'; }
  if (target && target.kind === 'external' && (k === 'http' || k === 'external')) return 'external';
  if (k === 'external' && target && target.kind !== 'external') return 'http';
  return k;
}
const rels = new Map();
const nodeStatus = (n) => n.status || '';
function addRel(from, to, kind, what, ev, extra = {}) {
  if (!from || !to || from === to) return;
  const key = `${from.id}\u0000${to.id}\u0000${kind}`;
  let r = rels.get(key);
  // an edge without its own status inherits the less-built of its two ends
  const st = extra.status || [nodeStatus(from), nodeStatus(to)].sort((a, b) => RANK[b] - RANK[a])[0];
  if (!r) { r = { id: `r${rels.size}`, from: from.id, to: to.id, kind, label: shortLabel(what) || kind, count: 0, details: [], evidence: [], _st: [], _cf: [] }; rels.set(key, r); }
  r.count++;
  if (what && !r.details.includes(str(what))) r.details.push(str(what));
  if (extra.envVar) r.details.push(`env ${extra.envVar}`);
  if (ev && r.evidence.length < 6) r.evidence.push(ev);
  r._st.push(st || 'built'); r._cf.push(extra.confidence || '');
}
const resolveRef = (raw, where) => { const n = byRaw.get(str(raw)); if (!n) err(`${where}: unknown id "${str(raw)}"`); return n; };
services.forEach((s, i) => {
  const from = byRaw.get(str(s.id)); if (!from) return;
  arr(s.calls).forEach((c, j) => {
    if (typeof c !== 'object') return;
    const where = `services[${i}].calls[${j}]`, to = resolveRef(c.to, where); if (!to) return;
    const st = c.status ? status(c.status, where).status : '';
    addRel(from, to, kindFor(c.via, to, where), str(c.what), [SRC, lineOf(['services', i, 'calls', j]), str(c.what) || `${str(s.id)} → ${str(c.to)}`], { status: st, confidence: conf(c), envVar: str(c.envVar) });
  });
});
const hasRel = (a, b, kind) => [...rels.values()].some((r) => r.from === a.id && r.to === b.id && (!kind || r.kind === kind));
arr(M.datastores).forEach((d, i) => {
  const to = byRaw.get(str(d?.id)); if (!to) return;
  arr(d.usedBy).forEach((u, j) => {
    const where = `datastores[${i}].usedBy[${j}]`, from = resolveRef(typeof u === 'object' ? u.service : u, where); if (!from || hasRel(from, to, 'db')) return;
    const access = str(u?.access).toLowerCase();
    addRel(from, to, 'db', str(u?.what) || (access === 'read' ? 'reads' : access === 'write' ? 'writes' : 'reads and writes'), [SRC, lineOf(['datastores', i, 'usedBy', j]), `${str(from.label)} ${access || 'uses'} ${str(to.label)}`], { confidence: conf(u) || conf(d) });
  });
});
arr(M.external).forEach((d, i) => {
  const to = byRaw.get(str(d?.id)); if (!to) return;
  arr(d.usedBy).forEach((u, j) => {
    const where = `external[${i}].usedBy[${j}]`, from = resolveRef(typeof u === 'object' ? u.service : u, where); if (!from || hasRel(from, to) || hasRel(to, from)) return;
    addRel(from, to, 'external', `uses ${to.label}`, [SRC, lineOf(['external', i, 'usedBy', j]), `${str(from.label)} uses ${str(to.label)}`], { confidence: conf(d) });
  });
});
arr(M.sharedLibs).forEach((d, i) => {
  const to = byRaw.get(str(d?.id) || str(d?.name)); if (!to) return;
  arr(d.usedBy).forEach((u, j) => {
    const where = `sharedLibs[${i}].usedBy[${j}]`, from = resolveRef(typeof u === 'object' ? u.service : u, where); if (!from) return;
    addRel(from, to, 'import', `uses ${to.label}`, [SRC, lineOf(['sharedLibs', i, 'usedBy', j]), `${str(from.label)} uses ${str(to.label)}`], { confidence: conf(d) });
  });
});
const relations = [...rels.values()].map(({ _st, _cf, ...r }) => {
  const worst = _st.sort((a, b) => RANK[a] - RANK[b])[0]; // the edge is as built as its most-built call
  if (worst && worst !== 'built') r.status = worst;
  if (_cf.every((c) => c === 'low')) r.confidence = 'low';
  if (r.details.length > 1 && r.count > 1) r.label = `${r.label} +${r.count - 1}`;
  return r;
});

// ---------------------------------------------------------------- flows
const flows = arr(M.flows).filter((f) => typeof f === 'object').map((f, i) => {
  const where = `flows[${i}]`;
  const steps = arr(f.steps).map((s, j) => {
    const w = `${where}.steps[${j}]`, a = resolveRef(s?.from, w), b = resolveRef(s?.to, w);
    if (!a || !b) return null;
    const st = s.status ? status(s.status, w).status : '';
    const tags = [st && st !== 'built' ? st : '', conf(s) ? 'inferred' : ''].filter(Boolean);
    return { from: a.id, to: b.id, kind: kindFor(s.via, b, w), text: str(s.what) || `${a.label} → ${b.label}`, detected: true, tags };
  }).filter(Boolean);
  if (!steps.length) warn(`${where}: no usable steps`);
  return { id: str(f.id) || slug(f.name) || `flow-${i + 1}`, title: str(f.name) || str(f.title) || `Flow ${i + 1}`, summary: str(f.description),
    status: str(f.status) || '', footnote: steps.some((s) => s.tags.includes('inferred')) ? 'Steps tagged inferred are not stated directly by a source.' : '', steps };
}).filter((f) => f.steps.length);
root.relations = relations;
root.rollups = {};
root.flows = flows;

// ---------------------------------------------------------------- optional drill-down into a per-repo tree
function graft(treePath, svc, where) {
  const base = dirname(MANIFEST), p = resolve(base, treePath);
  if (!existsSync(p)) { warn(`${where}: tree ${treePath} not found; showing interfaces instead`); return null; }
  // a manifest may only pull in trees that live next to it (no absolute paths, ../ or symlinks out)
  const rel = relative(realpathSync(base), realpathSync(p));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !statSync(p).isFile()) { warn(`${where}: tree ${treePath} is outside the manifest's folder; showing interfaces instead`); return null; }
  let t; try { t = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { err(`${where}: tree ${treePath}: ${e.message}`); return null; }
  if (!t?.root || !Array.isArray(t.root.children)) { err(`${where}: tree ${treePath} has no root.children`); return null; }
  const pre = (id) => `${svc.id}/${id}`;
  const walk = (n) => ({ ...n, id: pre(n.id), children: arr(n.children).map(walk), edges: arr(n.edges).map((e) => ({ ...e, from: pre(e.from), to: pre(e.to) })) });
  const kids = t.root.children.map(walk);
  for (const r of arr(t.root.relations)) grafted.push({ ...r, id: pre(r.id), from: pre(r.from), to: pre(r.to) });
  for (const [k, v] of Object.entries(t.root.rollups || {})) graftedRollups[k.split('|').map(pre).join('|')] = v;
  for (const f of arr(t.root.flows)) if (f && typeof f === 'object') graftedFlows.push({ ...f, id: pre(str(f.id) || 'flow'), title: `${svc.label}: ${str(f.title) || 'Flow'}`, steps: arr(f.steps).filter((s) => s && typeof s === 'object').map((s) => ({ ...s, from: pre(s.from), to: pre(s.to) })) });
  return kids;
}
if (grafted.length) { root.relations.push(...grafted); Object.assign(root.rollups, graftedRollups); }
if (graftedFlows.length) root.flows.push(...graftedFlows);

// ---------------------------------------------------------------- write
let nodeCount = 0; const perLevel = [];
(function walk(n, d) { nodeCount++; perLevel[d] = (perLevel[d] || 0) + 1; n.children.forEach((c) => walk(c, d + 1)); })(root, 0);
const LEVELS = ['system', 'groups', 'services', 'interfaces', 'details', 'files'];
const relationKinds = {}; for (const r of root.relations) relationKinds[r.kind] = (relationKinds[r.kind] || 0) + 1;
const meta = { source: `system manifest ${SRC}`, generatedAt: new Date().toISOString(), generator: 'loupe manifest', levels: perLevel.length, levelNames: LEVELS.slice(0, perLevel.length),
  nodesPerLevel: perLevel, nodeCount, relationCount: root.relations.length, relationKinds, flowCount: root.flows.length,
  statusCounts: [...byRaw.values()].reduce((m, n) => { const k = n.status || 'unspecified'; m[k] = (m[k] || 0) + 1; return m; }, {}),
  inferredItems: [...byRaw.values()].filter((n) => n.confidence === 'low').length };
for (const w of warnings) console.error(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length && strict) process.exit(1);
writeFileSync(OUT, JSON.stringify({ meta, root }, null, 2));
console.log(`wrote ${OUT} (${nodeCount} nodes, ${root.relations.length} relations, ${root.flows.length} flows; ${errors.length} errors, ${warnings.length} warnings)`);
