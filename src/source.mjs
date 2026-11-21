// Source-file filters and lightweight symbol extraction shared by generate.mjs and relations.mjs.
export const SRC_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sql|prisma|py|go|rs|rb|java|kt|swift|php|cs|c|h|cc|cxx|hh|hxx|cpp|hpp|c\+\+|h\+\+|m|mm|scala|ex|exs|vue|svelte)$/;
export const JS_TS_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|vue|svelte)$/;
export const SECRET_FILE = /(^|\/)\.env|secret|credential|\.pem$|private[-_]?key/i;
export const EXCLUDE = /(\.test\.|\.spec\.|_test\.(go|py|rb|rs)$|(^|\/)test_[^/]+\.py$|(^|\/)__tests__\/|(^|\/)tests?\/|(^|\/)test-d\/|test-support|\.d\.m?ts$|(^|\/)migrations\/|(^|\/)fixtures?\/|(^|\/)docs\/conf\.py$)/;
export const VENDOR_GEN_EXCLUDE = /((^|\/)(vendor|vendors|third_party|third-party|Pods|Carthage|bower_components|node_modules|build|out|target|dist|\.next|\.nuxt|\.svelte-kit|coverage|generated|__generated__)\/|\.min\.(js|css)$|\.bundle\.js$|\.pb(\.gw)?\.go$|_pb2(_grpc)?\.py$|\.generated\.[^/]+$|\.g\.dart$|\.[Dd]esigner\.cs$)/;

// Any `gen/` directory (at any depth) that contains protobuf files (`*.pb.*`).
export function protoGenDirs(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const m = p.match(/^((?:.+\/)?gen\/).*\.pb\.[^/]+$/);
    if (m) dirs.add(m[1]);
  }
  return dirs;
}

// Skip minified/bundled source: average line length > 500 chars or any single line > 5000 chars.
export function isMinified(text) {
  if (!text) return false;
  const lines = text.replace(/\r?\n$/, '').split('\n');
  if (!lines.length) return false;
  let total = 0;
  for (const l of lines) {
    const len = l.endsWith('\r') ? l.length - 1 : l.length;
    if (len > 5000) return true;
    total += len;
  }
  return total / lines.length > 500;
}

// Batched git-based filters for vendored/generated/ignored files:
//   - tracked files matching .gitignore (`git ls-files -z -ci --exclude-standard`)
//   - .gitattributes (`linguist-vendored`, `linguist-generated`, `-diff`, `binary`) in one batched `check-attr` call
//   - default vendored/build/generated path patterns (overridden by linguist-vendored=false / linguist-generated=false)
export function gitSourceFilters(repo, candidatePaths, gitFn, allGitPaths = candidatePaths) {
  const ignored = new Set();
  try {
    const out = gitFn(repo, ['ls-files', '-z', '-ci', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    for (const p of out.split('\0')) if (p) ignored.add(p);
  } catch {}

  const attrs = new Map(); // path -> { excluded, included }
  if (candidatePaths.length) {
    try {
      const out = gitFn(
        repo,
        ['check-attr', '--stdin', '-z', 'linguist-vendored', 'linguist-generated', 'diff', 'binary', '--'],
        { encoding: 'utf8', input: candidatePaths.join('\0') + '\0', maxBuffer: 256 * 1024 * 1024 },
      );
      const raw = new Map();
      const parts = out.split('\0');
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const p = parts[i];
        if (!p) continue;
        let rec = raw.get(p);
        if (!rec) raw.set(p, (rec = {}));
        rec[parts[i + 1]] = parts[i + 2];
      }
      const isTrue = (v) => v === 'set' || v === 'true';
      const isFalse = (v) => v === 'unset' || v === 'false';
      for (const [p, a] of raw) {
        const excluded = isTrue(a['linguist-vendored']) || isTrue(a['linguist-generated']) || isTrue(a.binary) || isFalse(a.diff);
        const included = !excluded && (isFalse(a['linguist-vendored']) || isFalse(a['linguist-generated']));
        attrs.set(p, { excluded, included });
      }
    } catch {}
  }

  const genDirs = [...protoGenDirs(allGitPaths)];
  const isIncludedByAttr = (p) => !!attrs.get(p)?.included;
  const isSkippedPath = (p) => {
    const a = attrs.get(p);
    if (a?.excluded) return true;
    if (a?.included) return false;
    if (ignored.has(p)) return true;
    if (VENDOR_GEN_EXCLUDE.test(p)) return true;
    if (genDirs.length && genDirs.some((d) => p.startsWith(d))) return true;
    return false;
  };
  return { ignored, attrs, isIncludedByAttr, isSkippedPath };
}

// Extract lightweight top-level exported symbols for common languages (best-effort, regex-only).
export function extractExports(filePath, text) {
  const out = [];
  if (JS_TS_EXT.test(filePath)) {
    for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm)) {
      out.push(m[1].startsWith('function') ? `${m[2]}()` : m[1] === 'class' ? `class ${m[2]}` : m[2]);
    }
  } else if (filePath.endsWith('.prisma')) {
    for (const m of text.matchAll(/^[ \t]*model\s+(\w+)\s*\{/gm)) out.push(`model ${m[1]}`);
  } else if (filePath.endsWith('.sql')) {
    for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)) out.push(`table ${m[1].replace(/"/g, '')}`);
  } else if (filePath.endsWith('.py')) {
    for (const m of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/gm)) out.push(`${m[1]}()`);
    for (const m of text.matchAll(/^class\s+([A-Za-z]\w*)\b/gm)) out.push(`class ${m[1]}`);
  } else if (filePath.endsWith('.go')) {
    for (const m of text.matchAll(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*(?:\[|\()/gm)) out.push(`${m[1]}()`);
    for (const m of text.matchAll(/^type\s+([A-Z]\w*)\b/gm)) out.push(`type ${m[1]}`);
  } else if (filePath.endsWith('.rs')) {
    for (const m of text.matchAll(/^\s*pub\s+(?:(?:async|unsafe|const)\s+)*fn\s+([A-Za-z_]\w*)/gm)) out.push(`${m[1]}()`);
    for (const m of text.matchAll(/^\s*pub\s+(struct|enum|trait)\s+([A-Za-z_]\w*)/gm)) out.push(`${m[1]} ${m[2]}`);
  }
  return [...new Set(out)];
}
