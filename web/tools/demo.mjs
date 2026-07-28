// demo.mjs — stage a destruction event, let debris settle, then capture before/after.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const out = process.argv[2] || 'shots/demo';
const view = process.argv[3] || 'street';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });
console.log('stats:', JSON.stringify(await page.evaluate(() => window.__app.stats())));

// The renderer deliberately stops converging while anything is moving: it holds a few
// frames of history and clamps rather than accumulating a mean (see motionSamples in
// renderer.js). Waiting for a sample count that will never arrive just spins for
// hundreds of software-rendered frames, so stop as soon as it is as resolved as it is
// going to get.
const settle = async (target = 96) => {
  let last = -1, stall = 0;
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.__app.renderFrames(4));
    const st = await page.evaluate(() => {
      const R = window.__app.renderer;
      return { s: R.samples ?? 0, motion: !!R.inMotion, hold: R.params.motionSamples };
    });
    if (st.s >= target) break;
    if (st.motion && st.s >= st.hold) break;
    if (st.s === last && ++stall > 3) break; else if (st.s !== last) stall = 0;
    last = st.s;
  }
};

await page.evaluate((v) => window.__app.setView(v), view);
await settle();
writeFileSync(`${out}/1_before.png`, await page.screenshot());
console.log('wrote before');

// Rocket the warehouse facade, then let the debris fall and settle.
const solidBefore = await page.evaluate(() => window.__app.countSolid());
await page.evaluate(() => window.__app.fireAt('rocket', [6.0, 2.6, 4.0], [12.2, 2.4, 8.0], 1));
// Capture mid-flight first: debris tumbling is the moment worth verifying.
await page.evaluate(() => window.__app.simulate(0.28));
await settle(48);
writeFileSync(`${out}/2_midair.png`, await page.screenshot());
console.log('midair stats:', JSON.stringify(await page.evaluate(() => window.__app.stats())));
await page.evaluate(() => window.__app.simulate(5));
const solidAfter = await page.evaluate(() => window.__app.countSolid());
console.log('solid', solidBefore, '->', solidAfter, 'destroyed', solidBefore - solidAfter);
console.log('post stats:', JSON.stringify(await page.evaluate(() => window.__app.stats())));
await settle();
writeFileSync(`${out}/3_after.png`, await page.screenshot());
console.log('wrote after');
if (errs.length) { console.log('ERRORS:'); errs.slice(0,8).forEach(e=>console.log(' ',e)); }
await browser.close();
