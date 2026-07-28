// Probe: can headless Chromium give us a real WebGL2 context, and can we screenshot
// an actual three.js render? The whole visual-critic loop depends on this being真
// genuinely true, so verify before building on top of it.
import { launchChromium } from './browser.mjs';
import { writeFileSync } from 'fs';

const FLAG_SETS = [
  { name: 'default', args: [] },
  { name: 'swiftshader', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'angle-swiftshader', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'gpu-desktop', args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-unsafe-swiftshader'] },
];

const URL = 'http://127.0.0.1:8899/probe.html';
let winner = null;

for (const set of FLAG_SETS) {
  let browser;
  try {
    browser = await launchChromium();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.__probe !== undefined, { timeout: 15000 });
    const info = await page.evaluate(() => window.__probe);
    console.log(`[${set.name}]`, JSON.stringify(info));
    if (errs.length) console.log(`   errors:`, errs.slice(0, 3));
    if (info.ok && !winner) {
      winner = set;
      writeFileSync('/home/user/AIBS/web/tools/probe_shot.png', await page.screenshot());
    }
    await browser.close();
  } catch (e) {
    console.log(`[${set.name}] FAIL: ${String(e).split('\n')[0].slice(0, 160)}`);
    if (browser) await browser.close().catch(() => {});
  }
}
console.log('\nWINNER:', winner ? winner.name : 'NONE', winner ? JSON.stringify(winner.args) : '');
