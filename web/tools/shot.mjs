// shot.mjs — headless screenshot harness. Drives named views and writes PNGs.
// Usage: node tools/shot.mjs [outDir] [view1,view2,...] [width] [height]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const outDir = process.argv[2] || 'shots';
const views  = (process.argv[3] || 'street,approach,corner,interior,closeup,container').split(',');
const W = parseInt(process.argv[4] || '960', 10);
const H = parseInt(process.argv[5] || '540', 10);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });
} catch (e) {
  console.error('APP NEVER BECAME READY');
  errors.forEach(x => console.error('  ', x));
  await browser.close();
  process.exit(1);
}
const stats = await page.evaluate(() => window.__app.stats());
console.log('stats:', JSON.stringify(stats));

for (const v of views) {
  await page.evaluate((name) => window.__app.setView(name), v);
  await page.evaluate(() => window.__app.renderFrames(4));
  await page.waitForTimeout(120);
  const buf = await page.screenshot();
  writeFileSync(`${outDir}/${v}.png`, buf);
  console.log('wrote', `${outDir}/${v}.png`);
}
if (errors.length) { console.log('\nPAGE ERRORS:'); errors.slice(0,10).forEach(e => console.log('  ', e)); }
await browser.close();
