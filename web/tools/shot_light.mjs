// shot_light.mjs — renderer/lighting screenshot harness (port 8811).
// Usage: node tools/shot_light.mjs [outDir] [view1,view2,...] [width] [height] [accumFrames]
import { launchChromium } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'fs';

const outDir = process.argv[2] || 'shots/light';
const views  = (process.argv[3] || 'street,corner,interior,closeup,aerial').split(',');
const W = parseInt(process.argv[4] || '960', 10);
const H = parseInt(process.argv[5] || '540', 10);
const ACC = parseInt(process.argv[6] || '96', 10);
const OVERRIDES = process.argv[7] ? JSON.parse(process.argv[7]) : null;
mkdirSync(outDir, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });

await page.goto('http://127.0.0.1:8811/index.html', { waitUntil: 'load', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180000 });
} catch (e) {
  console.error('APP NEVER BECAME READY');
  errors.forEach(x => console.error('  ', x));
  await browser.close();
  process.exit(1);
}
const stats = await page.evaluate(() => window.__app.stats());
console.log('stats:', JSON.stringify(stats));
if (OVERRIDES) {
  await page.evaluate((o) => {
    Object.assign(window.__app.renderer.params, o);
    window.__app.renderer.applyParams();
  }, OVERRIDES);
  console.log('overrides:', JSON.stringify(OVERRIDES));
}

for (const v of views) {
  const t0 = Date.now();
  await page.evaluate((name) => { window.__app.setView(name); window.__app.renderer.resetAccumulation?.(); }, v);
  // warm-up frame, timed
  const one = await page.evaluate(async () => {
    const t = performance.now();
    window.__app.renderFrames(1);
    // force GPU sync
    await new Promise(r => requestAnimationFrame(r));
    return performance.now() - t;
  });
  let done = 1;
  while (done < ACC) {
    const n = Math.min(8, ACC - done);
    await page.evaluate((k) => window.__app.renderFrames(k), n);
    done += n;
  }
  await page.waitForTimeout(150);
  const buf = await page.screenshot();
  writeFileSync(`${outDir}/${v}.png`, buf);
  const spp = await page.evaluate(() => window.__app.renderer.stats.samples ?? -1);
  console.log(`wrote ${outDir}/${v}.png  frame1=${one.toFixed(0)}ms total=${((Date.now()-t0)/1000).toFixed(1)}s spp=${spp}`);
}
if (errors.length) { console.log('\nPAGE ERRORS:'); errors.slice(0,10).forEach(e => console.log('  ', e)); }
await browser.close();
