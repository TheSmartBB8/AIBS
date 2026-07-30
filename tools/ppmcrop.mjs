// ppmcrop.mjs — cut a region out of a PPM and blow it up, nearest-neighbour, to a PNG.
//
// Exists because "it still looks blocky" cannot be settled by staring at a 1280x720 render
// that the chat client has already resampled to fit. A downscale is itself a low-pass filter,
// so it hides exactly the pixel-scale structure the question is about, and it can just as
// easily invent moire that is not in the source. Magnifying a crop with no interpolation shows
// the actual samples the renderer produced, which is the only thing worth arguing about.
//
// Usage: node tools/ppmcrop.mjs in.ppm out.png x y w h [zoom]
import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

const [, , inPath, outPath, xs, ys, ws, hs, zs] = process.argv;
if (!inPath || !outPath || xs === undefined) {
  console.error('usage: node tools/ppmcrop.mjs <in.ppm> <out.png> <x> <y> <w> <h> [zoom]');
  process.exit(1);
}
const cx = +xs, cy = +ys, cw = +ws, ch = +hs, zoom = zs ? +zs : 4;

const buf = readFileSync(inPath);
let pos = 0;
const token = () => {
  while (pos < buf.length) {
    const c = buf[pos];
    if (c === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; }
    else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
    else break;
  }
  const start = pos;
  while (pos < buf.length && ![0x20, 0x09, 0x0a, 0x0d].includes(buf[pos])) pos++;
  return buf.toString('ascii', start, pos);
};
if (token() !== 'P6') { console.error('not a binary PPM'); process.exit(1); }
const W = parseInt(token(), 10), H = parseInt(token(), 10);
if (parseInt(token(), 10) !== 255) { console.error('only 8-bit PPM'); process.exit(1); }
pos++;
const px = buf.subarray(pos);

const ow = cw * zoom, oh = ch * zoom;
const raw = Buffer.alloc((ow * 3 + 1) * oh);
for (let y = 0; y < oh; y++) {
  const rowStart = y * (ow * 3 + 1);
  raw[rowStart] = 0;                                  // filter: none
  const sy = Math.min(H - 1, cy + Math.floor(y / zoom));
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(W - 1, cx + Math.floor(x / zoom));
    const s = (sy * W + sx) * 3, d = rowStart + 1 + x * 3;
    raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2];
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = chunk.tbl || (chunk.tbl = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = ~0;
  for (const b of td) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${outPath} — ${cw}x${ch} at (${cx},${cy}) from ${W}x${H}, ${zoom}x -> ${ow}x${oh}`);
