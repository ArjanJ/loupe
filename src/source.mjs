// Source-file filters and lightweight symbol extraction shared by generate.mjs and relations.mjs.
export const SRC_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sql|prisma|py|go|rs|rb|java|kt|swift|php|cs|c|h|cpp|hpp|scala|ex|exs|vue|svelte)$/;
export const JS_TS_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|vue|svelte)$/;
export const SECRET_FILE = /(^|\/)\.env|secret|credential|\.pem$|private[-_]?key/i;
export const EXCLUDE = /(\.test\.|\.spec\.|_test\.(go|py|rb|rs)$|(^|\/)test_[^/]+\.py$|(^|\/)__tests__\/|(^|\/)tests?\/|test-support|\.d\.m?ts$|(^|\/)dist\/|node_modules|(^|\/)migrations\/|(^|\/)fixtures?\/)/;

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
