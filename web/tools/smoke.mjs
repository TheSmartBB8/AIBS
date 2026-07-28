// smoke.mjs — does the renderer actually compile and draw? Exit 1 if not.
//
// This exists because tests/all.mjs cannot answer that question and quietly implied it
// could. Its shader checks are structural — balanced braces, and every uniform the GLSL
// declares being one the renderer supplies — which catches a truncated template literal
// but not a semantic error. I removed a helper function while deleting a feature, left a
// call to it behind, watched 627 checks pass, and pushed a renderer whose composite pass
// did not compile. The image was black and nothing in the suite noticed.
//
// Offline validation with glslangValidator was the obvious alternative and was rejected:
// three.js synthesises its own preamble for GLSL3 materials (the varying/in rewrite, the
// output declaration, the injected defines), so validating the raw strings would either
// need that preamble reimplemented here — free to drift out of sync, silently — or would
// report errors that are not real. The browser is the ground truth for what compiles, and
// there is already a headless one.
//
// Usage: node tools/smoke.mjs [port]     (starts its own server; needs no setup)
import { launchChromium } from './browser.mjs';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const PORT = parseInt(process.argv[2] || '8901', 10);
const ROOT = 'public';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
// three.js reports a failed shader compile through console.error, not by throwing, so a
// broken renderer looks exactly like a working one unless this is being watched.
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });

let ok = true;
try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180000 });
  await page.evaluate(() => { window.__app.freeze(); window.__app.renderFrames(3); });
} catch (e) {
  errors.push('FAILED TO RUN: ' + e.message);
  ok = false;
}

// A 404 for a favicon is not a renderer fault; a shader that will not compile is.
const real = errors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
if (real.length) {
  ok = false;
  console.error('SHADER / RUNTIME ERRORS:');
  real.slice(0, 12).forEach((e) => console.error('  ' + e));
} else if (ok) {
  const stats = await page.evaluate(() => window.__app.stats());
  console.log(`OK — compiled and drew ${stats.chunks} chunks, ${stats.triangles} triangles`);
}

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
