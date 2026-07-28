// verify_pack.mjs — prove the packed single-file build actually runs from file://
//
// The whole point of packing is that it needs no server. Loading it over http would
// verify nothing, so this opens the real file:// URL, waits for the app, renders, and
// screenshots — the same path the user takes when they double-click it.
import { launchChromium } from './browser.mjs';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const file = process.argv[2] || 'dist/voxwreck.html';
const shot = process.argv[3] || null;
const url = 'file://' + resolve(file);

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('requestfailed', (r) => errors.push('REQUESTFAILED: ' + r.url().slice(0, 120)));

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
let ok = true;
try {
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 180000 });
} catch {
  ok = false;
}
if (!ok) {
  console.error('FAIL: the packed build never became ready at ' + url);
  errors.slice(0, 10).forEach((e) => console.error('  ', e));
  await browser.close();
  process.exit(1);
}

const stats = await page.evaluate(() => window.__app.stats());
console.log('ready from file:// —', JSON.stringify(stats));

// A blank canvas would also report "ready", so render and check the image has content.
//
// Freeze first. Playwright's screenshot waits for the page to yield a frame, and under
// SwiftShader the à-trous passes make each frame expensive enough that a free-running rAF
// loop starves it — the capture timed out at 30 s against a build that was rendering
// perfectly well. Stopping the loop leaves the last rendered frame on the canvas and the
// page idle, which is what the capture needs.
await page.evaluate(() => { window.__app.freeze(); window.__app.setView('street'); });
await page.evaluate(() => window.__app.renderFrames(24));
const buf = await page.screenshot({ timeout: 120000 });
if (shot) writeFileSync(shot, buf);

// Measure the *screenshot*, not the live canvas. Reading back from a WebGL canvas with
// drawImage needs preserveDrawingBuffer, which the renderer does not set (and should not
// — it costs a full-target copy every frame); without it the read comes back all zeroes
// and a perfectly good build looks like a black screen.
const probe = await browser.newPage();
const spread = await probe.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const g = document.createElement('canvas');
  g.width = 64; g.height = 36;
  const ctx = g.getContext('2d');
  ctx.drawImage(img, 0, 0, 64, 36);
  const d = ctx.getImageData(0, 0, 64, 36).data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    if (l < lo) lo = l; if (l > hi) hi = l;
  }
  return { lo, hi };
}, buf.toString('base64'));
await probe.close();
console.log('luma range', JSON.stringify(spread));
const drew = spread.hi - spread.lo > 40;
console.log(drew ? 'PASS: the packed build renders a real image with no server'
                 : 'FAIL: canvas is flat — nothing was drawn');
if (errors.length) { console.log('page errors:'); errors.slice(0, 8).forEach((e) => console.log('  ', e)); }
await browser.close();
process.exit(drew ? 0 : 1);
