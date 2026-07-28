// sweep.mjs — render one view under several renderer parameter sets in a single page load.
//
// The level takes ~2.5 s to build and the volume upload is not cheap, so reloading the
// page per variant made comparing four candidate looks a five-minute round trip. Here the
// world is built once and only the uniforms change between shots, which makes the
// difference between variants genuinely attributable to the parameters.
//
// Usage: node tools/sweep.mjs <view> <out.png> '<json array of param objects>' [w] [h]
//   node tools/sweep.mjs street /tmp/s.png '[{},{"envFog":0.003},{"bounce":1.6}]'
import { launchChromium } from './browser.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const view = process.argv[2] || 'street';
const out = process.argv[3] || 'shots/sweep.png';
const variants = JSON.parse(process.argv[4] || '[{}]');
const W = parseInt(process.argv[5] || '640', 10);
const H = parseInt(process.argv[6] || '360', 10);
const TARGET = parseInt(process.env.SAMPLES || '40', 10);
const PORT = process.env.PORT || '8899';
mkdirSync(dirname(out), { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180000 });
} catch {
  console.error('APP NEVER BECAME READY');
  errors.forEach((x) => console.error('  ', x));
  await browser.close();
  process.exit(1);
}

const shots = [];
for (const v of variants) {
  await page.evaluate(([name, params]) => {
    window.__app.setView(name);
    Object.assign(window.__app.renderer.params, params);
    window.__app.renderer.applyParams();
  }, [view, v]);
  let last = -1, stalled = 0;
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.__app.renderFrames(4));
    const s = await page.evaluate(() => window.__app.renderer.samples);
    if (s >= TARGET) break;
    if (s === last && ++stalled > 3) break;
    if (s !== last) stalled = 0;
    last = s;
  }
  shots.push({ label: JSON.stringify(v).slice(0, 96), b64: (await page.screenshot()).toString('base64') });
  console.log('rendered', JSON.stringify(v));
}

const cols = Math.min(shots.length, 2);
const cells = shots.map((s) =>
  `<figure><img src="data:image/png;base64,${s.b64}"><figcaption>${s.label.replace(/</g, '&lt;')}</figcaption></figure>`).join('\n');
const html = `<!doctype html><meta charset="utf-8"><style>
 body{margin:0;background:#15171c;font:600 12px ui-monospace,monospace;color:#c9d1d9}
 .g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:2px;padding:2px}
 figure{margin:0;position:relative}img{display:block;width:100%}
 figcaption{position:absolute;left:0;bottom:0;padding:3px 6px;background:rgba(0,0,0,.75);color:#f0a030}
</style><div class="g">${cells}</div>`;
const sheet = await browser.newPage({ viewport: { width: W * cols + 8, height: 100 } });
await sheet.setContent(html, { waitUntil: 'load' });
writeFileSync(out, await sheet.screenshot({ fullPage: true }));
console.log('wrote', out);
if (errors.length) errors.slice(0, 6).forEach((e) => console.log('  ', e));
await browser.close();
