// shot.mjs — headless screenshot harness. Drives named views and writes PNGs.
// Usage: node tools/shot.mjs [outDir] [view1,view2,...] [width] [height]
import { launchChromium } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'fs';

const outDir = process.argv[2] || 'shots';
const views  = (process.argv[3] || 'street,approach,corner,interior,closeup,container').split(',');
const W = parseInt(process.argv[4] || '960', 10);
const H = parseInt(process.argv[5] || '540', 10);
mkdirSync(outDir, { recursive: true });

const browser = await launchChromium();
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

// The renderer resolves its 1-sample-per-pixel raytracing temporally, so a shot is only
// worth judging once the history has accumulated. Render in batches (rather than one huge
// synchronous call) so a slow software frame can't trip the page's watchdog, and stop
// early once the sample count stops climbing.
const TARGET = parseInt(process.env.SAMPLES || '96', 10);
for (const v of views) {
  await page.evaluate((name) => window.__app.setView(name), v);
  let last = -1, stalled = 0;
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.__app.renderFrames(4));
    const st = await page.evaluate(() => {
      const R = window.__app.renderer;
      return { s: R?.samples ?? 0, motion: !!R?.inMotion, hold: R?.params?.motionSamples ?? 6 };
    });
    if (st.s >= TARGET) break;
    // While debris or smoke is live the renderer holds its history instead of averaging,
    // so the sample count plateaus by design and waiting for TARGET never returns.
    if (st.motion && st.s >= st.hold) break;
    if (st.s === last && ++stalled > 3) break;   // accumulation isn't advancing; don't spin
    if (st.s !== last) stalled = 0;
    last = st.s;
  }
  const s = await page.evaluate(() => window.__app.renderer?.samples ?? 0);
  await page.waitForTimeout(80);
  const buf = await page.screenshot();
  writeFileSync(`${outDir}/${v}.png`, buf);
  console.log(`wrote ${outDir}/${v}.png  (${s} samples)`);
}
if (errors.length) { console.log('\nPAGE ERRORS:'); errors.slice(0,10).forEach(e => console.log('  ', e)); }
await browser.close();
