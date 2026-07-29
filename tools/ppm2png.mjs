// ppm2png.mjs — convert the native renderer's PPM output to PNG.
//
// The game writes PPM because that needs no libraries linked into it: adding libpng to the
// engine so a build machine can take a screenshot would be letting the test wag the product.
// Node has zlib built in, so the encode is free here and costs the game nothing.
//
// Usage: node tools/ppm2png.mjs in.ppm out.png
import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/ppm2png.mjs <in.ppm> <out.png>');
  process.exit(1);
}

const buf = readFileSync(inPath);

// P6 header: magic, width, height, maxval — each separated by whitespace, with # comments
// allowed anywhere between tokens.
let pos = 0;
const token = () => {
  while (pos < buf.length) {
    const c = buf[pos];
    if (c === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; }      // comment
    else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
    else break;
  }
  const start = pos;
  while (pos < buf.length && ![0x20, 0x09, 0x0a, 0x0d].includes(buf[pos])) pos++;
  return buf.toString('ascii', start, pos);
};

if (token() !== 'P6') { console.error('not a binary PPM'); process.exit(1); }
const w = parseInt(token(), 10);
const h = parseInt(token(), 10);
const maxval = parseInt(token(), 10);
pos++;                                    // exactly one whitespace byte after maxval
if (maxval !== 255) { console.error('only 8-bit PPM supported'); process.exit(1); }

const px = buf.subarray(pos, pos + w * h * 3);
if (px.length < w * h * 3) { console.error(`truncated: ${px.length} of ${w * h * 3} bytes`); process.exit(1); }

// PNG scanlines are each prefixed with a filter byte; 0 means "no filter", which costs a
// little size and keeps this readable.
const raw = Buffer.alloc((w * 3 + 1) * h);
for (let y = 0; y < h; y++) {
  raw[y * (w * 3 + 1)] = 0;
  px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8;      // bit depth
ihdr[9] = 2;      // colour type 2 = truecolour RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${outPath} (${w}x${h})`);
