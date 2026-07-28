// rmse.mjs — measure a renderer change against ground truth instead of against taste.
//
// Why this exists, stated plainly, because it is the whole point:
//
// The denoiser was rewritten and reviewed by looking at before/after screenshots. Side by
// side the filtered 16-sample frame was obviously cleaner and I accepted it. Measured
// against a 512-sample reference, that same filter made the 32-sample frame 36% *worse*
// than not filtering at all — it was removing more signal than noise, and reading as an
// improvement because grain is what the eye notices and a slightly-wrong smooth image is
// not. A visual reviewer, however harsh, votes for the broken version every time.
//
// So: render a converged reference with the effect OFF, then render at low sample counts
// with it off and on, and report RMSE against the reference. Lower is closer to what the
// renderer would converge to given infinite time, which is the only defensible definition
// of "better" for a sampling change.
//
// Usage:
//   node tools/rmse.mjs [view] [outDir] [width] [height]
//   PASSES=5 REF=512 node tools/rmse.mjs interior
//
// Needs the dev server on :8899 (npm run serve).
import { launchChromium } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'fs';

const VIEW = process.argv[2] || 'car';
const OUT = `${process.argv[3] || 'shots/rmse'}/${VIEW}`;
const W = parseInt(process.argv[4] || '480', 10);
const H = parseInt(process.argv[5] || '300', 10);
const REF = parseInt(process.env.REF || '512', 10);
const PASSES = parseInt(process.env.PASSES || '5', 10);
// Starts at 1, deliberately. The original default began at 4, and that omission hid a real
// defect for several commits: the denoiser measured -35% at 4 samples and -61% in a dim
// interior, all of it from a *stationary* camera, while at 2 and 3 samples it was +15% and
// +39% — worse than not filtering. Any camera movement resets accumulation, so 1 sample is
// what you see while moving and 2-3 is what you pass through as it settles. Measuring only
// the range that converges nicely is measuring the case the player is least often in.
const STEPS = (process.env.STEPS || '1,2,3,8,32').split(',').map(Number);
mkdirSync(OUT, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });

// Freeze before anything else. The first version of this measurement was meaningless
// without it: the rAF loop kept simulating between calls and the renderer re-reads the
// wall clock for the cloud layer on every accumulation reset, so every shot rendered a
// different sky. RMSE *rose* with sample count — the drift dwarfed the effect entirely.
await page.evaluate(() => window.__app.freeze());
await page.evaluate(() => window.__app.simulate(2.5));
await page.evaluate((v) => window.__app.setView(v), VIEW);

// PNG decode happens in the page (createImageBitmap + OffscreenCanvas) so this needs no
// image library on the node side.
await page.evaluate(() => {
  window.__cmp = {
    store: {},
    async put(key, b64) {
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const bmp = await createImageBitmap(blob);
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      this.store[key] = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    },
    rmse(a, b) {
      const A = this.store[a], B = this.store[b];
      let s = 0, n = 0;
      for (let i = 0; i < A.length; i += 4)
        for (let c = 0; c < 3; c++) { const d = A[i + c] - B[i + c]; s += d * d; n++; }
      return Math.sqrt(s / n);
    },
  };
});

async function shoot(key, n, passes) {
  await page.evaluate((p) => {
    const R = window.__app.renderer;
    R.params.denoise = p > 0 ? 1 : 0;
    R.params.denoisePasses = Math.max(p, 1);
    R.resetAccumulation();
  }, passes);
  for (let guard = 0; guard < 500; guard++) {
    const s = await page.evaluate(() => window.__app.renderer.samples);
    if (s >= n) break;
    await page.evaluate((k) => window.__app.renderFrames(k), Math.min(8, n - s));
  }
  const buf = await page.screenshot({ timeout: 120000 });
  writeFileSync(`${OUT}/${key}.png`, buf);
  await page.evaluate(([k, b]) => window.__cmp.put(k, b), [key, buf.toString('base64')]);
}

// The reference must be unfiltered. Comparing the filter against its own output at a
// higher sample count would measure nothing but how stable the filter is.
await shoot('ref', REF, 0);
console.log(`view ${VIEW} — reference ${REF} samples, filter off\n`);
console.log('samples   RMSE off   RMSE on    change');
for (const n of STEPS) {
  await shoot(`off${n}`, n, 0);
  await shoot(`on${n}`, n, PASSES);
  const ro = await page.evaluate((k) => window.__cmp.rmse('off' + k, 'ref'), n);
  const rn = await page.evaluate((k) => window.__cmp.rmse('on' + k, 'ref'), n);
  const pct = (rn - ro) / ro * 100;
  console.log(`${String(n).padStart(7)}   ${ro.toFixed(3).padStart(8)}   ${rn.toFixed(3).padStart(7)}   ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
}
if (errs.length) { console.log('\nERRORS:'); errs.slice(0, 8).forEach((e) => console.log(' ', e)); }
await browser.close();
