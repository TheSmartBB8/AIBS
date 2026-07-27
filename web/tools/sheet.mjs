// sheet.mjs — composite a directory of screenshots into a single labelled contact sheet.
// Reviewing six views costs one image instead of six, which matters a lot when a critic
// loop is iterating. Uses the browser we already have rather than an image library.
//
// Usage: node tools/sheet.mjs <shotsDir> <out.png> [cols] [label]
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const dir = process.argv[2] || 'shots/latest';
const out = process.argv[3] || 'shots/sheet.png';
const cols = parseInt(process.argv[4] || '3', 10);
const label = process.argv[5] || basename(dir);

const files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
if (!files.length) { console.error('no PNGs in ' + dir); process.exit(1); }

const cells = files.map(f => {
  const b64 = readFileSync(join(dir, f)).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${basename(f, '.png')}</figcaption></figure>`;
}).join('\n');

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#15171c; font:600 13px ui-monospace,Menlo,monospace; color:#c9d1d9; }
  h1 { margin:0; padding:10px 14px; font-size:14px; letter-spacing:.08em; text-transform:uppercase;
       color:#f0a030; border-bottom:1px solid #2a2f38; }
  .grid { display:grid; grid-template-columns:repeat(${cols},1fr); gap:2px; padding:2px; }
  figure { margin:0; position:relative; }
  img { display:block; width:100%; height:auto; }
  figcaption { position:absolute; left:0; bottom:0; padding:3px 7px; background:rgba(0,0,0,.72);
               color:#f0a030; letter-spacing:.06em; }
</style><h1>${label}</h1><div class="grid">${cells}</div>`;

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480 * cols + 8, height: 800 } });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(300);
writeFileSync(out, await page.screenshot({ fullPage: true }));
await browser.close();
console.log(`sheet: ${out}  (${files.length} views: ${files.map(f => basename(f, '.png')).join(', ')})`);
