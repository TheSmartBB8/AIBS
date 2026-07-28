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
// worth judging once the history has accumulated.
//
// Settle the world before accumulating anything. The parked cars drop onto their
// suspension over the first ~0.5 s of simulation, and while any body is moving the
// renderer deliberately holds its history at motionSamples instead of averaging. The
// old loop went straight to accumulating, saw motion on the very first batch, and took
// the shot at 6 samples — every review screenshot up to now was judged at a fraction of
// the sample count it reported wanting, which made the renderer look far noisier than it
// is. Settling first costs a second and removes the failure entirely.
// Stop the world before touching anything: the rAF loop would otherwise keep simulating
// and accumulating between our calls, and the sky's clock would advance, so two runs of
// the same fixed view would not be the same picture. Fixed views only mean something if
// they are reproducible.
await page.evaluate(() => window.__app.freeze());
await page.evaluate(() => window.__app.simulate(2.5));

const TARGET = parseInt(process.env.SAMPLES || '96', 10);
for (const v of views) {
  await page.evaluate((name) => window.__app.setView(name), v);
  let last = -1, stalled = 0;
  for (let i = 0; i < 400; i++) {
    await page.evaluate(() => window.__app.renderFrames(4));
    const st = await page.evaluate(() => {
      const R = window.__app.renderer;
      return { s: R?.samples ?? 0, motion: !!R?.inMotion, hold: R?.params?.motionSamples ?? 6 };
    });
    if (st.s >= TARGET) break;
    // If something really is animating (a staged demolition, live smoke) the history is
    // held by design and TARGET is unreachable — but only give up once that has been true
    // for several batches running, so a brief twitch doesn't cost the whole shot.
    if (st.motion && st.s >= st.hold && ++stalled > 8) break;
    // Accumulation genuinely not advancing.
    if (st.s === last && ++stalled > 8) break;
    if (st.s !== last && !st.motion) stalled = 0;
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
