// Safe filesystem helpers: refuse symlinks / non-regular targets, realpath-confine dirs inside a repo,
// and write files atomically via a temp file + rename so writes never follow a symlink.
import { closeSync, constants as fsc, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export class SafeFsError extends Error {}

export function within(base, p) {
  const r = relative(base, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

export function lst(p) {
  try { return lstatSync(p); } catch { return null; }
}

const show = (p) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : p;
};

const refuse = (p, what, verb = 'use') => {
  throw new SafeFsError(`refusing to ${verb} ${show(p)}: it is ${what}. Remove it (it may come from the repo) and run loupe again.`);
};

// Refuse if `filePath` already exists as a symlink or non-regular file (FIFO, device, directory).
export function assertSafeFile(filePath) {
  const p = resolve(filePath);
  const st = lst(p);
  if (st && !st.isFile()) refuse(p, st.isSymbolicLink() ? 'a symlink' : 'not a regular file', 'write');
}

// Check all existing parent directories inside `withinDir` (when target is inside it) and the target file itself,
// without creating any directories yet.
export function checkSafePath(filePath, { withinDir = null } = {}) {
  const target = resolve(filePath);
  if (withinDir) {
    const base = resolve(withinDir);
    if (within(base, target)) {
      const realBase = realpathSync(base);
      const relDir = relative(base, dirname(target));
      let cur = base;
      for (const seg of relDir ? relDir.split(sep).filter(Boolean) : []) {
        cur = join(cur, seg);
        const st = lst(cur);
        if (!st) break;
        if (st.isSymbolicLink()) refuse(cur, 'a symlink');
        if (!st.isDirectory()) refuse(cur, 'not a directory');
        if (!within(realBase, realpathSync(cur))) refuse(cur, 'outside the repo');
      }
    }
  }
  assertSafeFile(target);
}

// Ensure `dirPath` is a real directory (never a symlink). When `withinDir` is given and `dirPath` lies inside it,
// walk every component from `withinDir` and require each one to be a real directory whose realpath stays inside `withinDir`.
export function safeDir(dirPath, { withinDir = null } = {}) {
  const target = resolve(dirPath);
  if (withinDir) {
    const base = resolve(withinDir);
    if (within(base, target)) {
      const realBase = realpathSync(base);
      const rel = relative(base, target);
      let cur = base;
      for (const seg of rel ? rel.split(sep).filter(Boolean) : []) {
        cur = join(cur, seg);
        const st = lst(cur);
        if (st?.isSymbolicLink()) refuse(cur, 'a symlink');
        if (st && !st.isDirectory()) refuse(cur, 'not a directory');
        if (!st) mkdirSync(cur);
        if (!within(realBase, realpathSync(cur))) refuse(cur, 'outside the repo');
      }
      return target;
    }
  }
  const st = lst(target);
  if (st?.isSymbolicLink()) refuse(target, 'a symlink');
  if (st && !st.isDirectory()) refuse(target, 'not a directory');
  if (!st) mkdirSync(target, { recursive: true });
  const st2 = lst(target);
  if (!st2 || st2.isSymbolicLink() || !st2.isDirectory()) refuse(target, st2?.isSymbolicLink() ? 'a symlink' : 'not a directory');
  return target;
}

// Safely write `content` to `filePath`: refuse symlink/non-regular targets, realpath-confine parent dirs inside `withinDir`,
// then write to a unique temp file in the same directory with `wx` and atomically rename into place.
export function safeWriteFile(filePath, content, { withinDir = null } = {}) {
  const target = resolve(filePath);
  const dir = dirname(target);
  if (withinDir && within(resolve(withinDir), target)) {
    safeDir(dir, { withinDir });
  } else if (!lst(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  assertSafeFile(target);
  const tmp = join(dir, `.loupe-tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    assertSafeFile(target);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Read files from an untrusted checkout. A path is readable only when it is
//   - a plain relative path inside the repo (no "..", not absolute),
//   - allowed by `allow(path)` (tracked by git, not secret-looking, not LOUPE_IGNOREd, ...),
//   - a regular file of at most `maxBytes`, with no symlink anywhere on the way: neither the file itself
//     (a tracked `src/config.ts -> ../.env.local` would otherwise send an ignored secret as source)
//     nor any directory above it.
// The final open uses O_NOFOLLOW where the platform has it, and the opened file must still be the one at the
// symlink-free path under the real repo root, so a file or parent directory swapped for a symlink after the check is not read.
export function repoReader(repo, { allow = () => true, maxBytes = 1024 * 1024 } = {}) {
  const base = resolve(repo);
  const norm = (p) => {
    // a backslash is a path separator only on Windows; elsewhere it is an ordinary file name character
    const n = posix.normalize(sep === '\\' ? String(p).replace(/\\/g, '/') : String(p));
    return !n || n === '.' || n === '..' || n.startsWith('../') || n.startsWith('/') || isAbsolute(n) ? null : n.replace(/\/+$/, '');
  };
  // every component from the repo root down must exist and be a real directory (or the final regular file)
  const walk = (n, last) => {
    const segs = n.split('/');
    let cur = base;
    for (let i = 0; i < segs.length; i++) {
      cur = join(cur, segs[i]);
      const st = lst(cur);
      if (!st || st.isSymbolicLink()) return null;
      if (i < segs.length - 1 ? !st.isDirectory() : !last(st)) return null;
    }
    return cur;
  };
  const isDir = (p) => { const n = p === '.' || p === '' ? '.' : norm(p); if (n === '.') return true; return !!n && !!walk(n, (st) => st.isDirectory()); };
  const isRegularFile = (p) => { const n = norm(p); return !!n && allow(n) && !!walk(n, (st) => st.isFile() && st.size <= maxBytes); };
  const read = (p) => {
    const n = norm(p);
    if (!n || !allow(n)) return '';
    const full = walk(n, (st) => st.isFile() && st.size <= maxBytes);
    if (!full) return '';
    let fd;
    try {
      fd = openSync(full, fsc.O_RDONLY | (fsc.O_NOFOLLOW || 0));
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > maxBytes) return '';
      // the path, resolved now, must have no symlink in it and must name the file we hold open
      const expected = join(realpathSync(base), ...n.split('/'));
      if (realpathSync(full) !== expected) return '';
      const now = statSync(expected);
      if (now.dev !== st.dev || now.ino !== st.ino) return '';
      return readFileSync(fd, 'utf8');
    } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  };
  return { isRegularFile, isDir, read };
}
