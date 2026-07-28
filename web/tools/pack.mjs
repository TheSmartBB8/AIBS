// pack.mjs — build the whole game into one self-contained .html file.
//
// The dev page loads ES modules over http with an import map, which needs a web server:
// a browser refuses `import` from file:// . That is fine while developing and useless for
// handing the game to someone. Bundling to a single classic <script> removes both the
// module loader and the server, so the result is one file that runs by double-clicking it.
//
// Usage: node tools/pack.mjs [out.html]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const out = process.argv[2] || 'dist/voxwreck.html';
mkdirSync(dirname(out), { recursive: true });

// `three` is a bare specifier resolved by the page's import map at runtime. esbuild has no
// import map, so point it at the same vendored copy the browser would have fetched.
const threeAlias = {
  name: 'three-alias',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: resolve('public/vendor/three.module.js') }));
    b.onResolve({ filter: /^three\/addons\// }, (a) => ({
      path: resolve('public/vendor/jsm', a.path.replace('three/addons/', '')),
    }));
  },
};

const res = await build({
  entryPoints: ['public/src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  plugins: [threeAlias],
  write: false,
});
const js = res.outputFiles[0].text;

// The shell mirrors public/index.html, minus the import map and the module script, plus a
// pointer-lock hint — a bundled build is the one people actually play, and a black canvas
// that does nothing until you click it is a bad first five seconds.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>VoxWreck</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0f16;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9}
canvas{display:block;width:100%;height:100%}
#hint{position:fixed;inset:auto 0 0 0;padding:10px 14px;background:rgba(8,11,16,.82);
  border-top:1px solid #222a35;letter-spacing:.02em}
#hint b{color:#f0a030;font-weight:600}
#hint.gone{display:none}
</style></head>
<body><canvas id="view"></canvas>
<div id="hint"><b>Click the canvas to play.</b> &nbsp; WASD move &middot; mouse look &middot;
left click fire &middot; 1-9 or scroll switch tool &middot; space jump &middot; shift sprint &middot;
ctrl crouch &middot; F toggle free camera &middot; Esc release the mouse</div>
<script>${js}</script>
<script>
document.addEventListener('pointerlockchange', () => {
  document.getElementById('hint').classList.toggle('gone', !!document.pointerLockElement);
});
</script>
</body></html>
`;

writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`wrote ${out} (${kb} KB, single file, no server needed)`);
