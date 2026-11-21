// Load Playwright from the project (npm i -D playwright && npx playwright install chromium),
// or from another install via PLAYWRIGHT_DIR=/path/to/node_modules.
import { createRequire } from 'node:module';
let pw;
try { pw = await import('playwright'); }
catch {
  if (!process.env.PLAYWRIGHT_DIR) { console.error('Playwright not found: run `npm i -D playwright && npx playwright install chromium`, or set PLAYWRIGHT_DIR.'); process.exit(2); }
  pw = createRequire(process.env.PLAYWRIGHT_DIR.replace(/\/?$/, '/'))('playwright');
}
export const chromium = pw.chromium || pw.default?.chromium;
