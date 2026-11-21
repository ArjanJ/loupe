// Safe filesystem helpers: refuse symlinks / non-regular targets, realpath-confine dirs inside a repo,
// and write files atomically via a temp file + rename so writes never follow a symlink.
import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
