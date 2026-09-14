'use strict';
/**
 * Marginalia's app icon: a warm gradient tile with a bold hand-drawn scrawl across
 * a page. Writes build/icon.png then build/icon.icns (sips + iconutil).
 * Run through `npm run icon`.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execFileSync } = require('child_process');

const S = 1024;
const buf = Buffer.alloc(S * (1 + S * 4));

const blend = (x, y, r, g, b, a) => {
  // BOTH coordinates must be whole numbers: a fractional row offset indexes
  // the buffer at a non-integer position and the write silently goes nowhere.
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const o = y * (1 + S * 4) + 1 + x * 4;
  const na = a / 255, ia = 1 - na;
  buf[o]     = Math.round(buf[o]     * ia + r * na);
  buf[o + 1] = Math.round(buf[o + 1] * ia + g * na);
  buf[o + 2] = Math.round(buf[o + 2] * ia + b * na);
  buf[o + 3] = Math.min(255, buf[o + 3] + a);
};

/** Rounded-square mask, the shape macOS icons want. */
const R = 235, M = 70;
const inTile = (x, y) => {
  const x0 = M, x1 = S - M, y0 = M, y1 = S - M;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + R), x1 - R);
  const cy = Math.min(Math.max(y, y0 + R), y1 - R);
  return Math.hypot(x - cx, y - cy) <= R;
};

// Tile: a diagonal sunset gradient, coral into indigo.
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inTile(x, y)) continue;
    const t = (x / S) * 0.45 + (y / S) * 0.55;
    blend(x, y,
      Math.round(0xff * (1 - t) + 0x6b * t),
      Math.round(0x6b * (1 - t) + 0x5a * t),
      Math.round(0x4a * (1 - t) + 0xd6 * t), 255);
  }
}

// The page, tilted a little so it feels tossed on the desk.
const ang = -0.075, ca = Math.cos(ang), sa = Math.sin(ang);
const pw = 430, ph = 540, cx0 = S / 2, cy0 = S / 2 - 8;
const pagePx = (u, v) => [cx0 + u * ca - v * sa, cy0 + u * sa + v * ca];
for (let v = -ph / 2; v < ph / 2; v += 0.5) {
  for (let u = -pw / 2; u < pw / 2; u += 0.5) {
    const [x, y] = pagePx(u, v);
    blend(x, y, 255, 255, 255, 252);
  }
}

// Highlighter band across the top third.
for (let v = -ph / 2 + 96; v < -ph / 2 + 168; v += 0.5) {
  for (let u = -pw / 2 + 44; u < pw / 2 - 76; u += 0.5) {
    const [x, y] = pagePx(u, v);
    blend(x, y, 0xff, 0xd4, 0x3b, 190);
  }
}

// Two ruled lines of "text".
for (const off of [215, 285]) {
  for (let v = -ph / 2 + off; v < -ph / 2 + off + 22; v += 0.5) {
    for (let u = -pw / 2 + 44; u < pw / 2 - (off === 285 ? 150 : 90); u += 0.5) {
      const [x, y] = pagePx(u, v);
      blend(x, y, 0x3a, 0x3a, 0x46, 165);
    }
  }
}

/** A thick round-capped stroke through the given points. */
const scrawl = (pts, radius, col) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= radius) blend(x + dx, y + dy, col[0], col[1], col[2],
            d > radius - 1.4 ? 150 : 255);
        }
      }
    }
  }
};

// The scrawl itself: a loose signature sweeping off the page edges.
const marks = [];
for (let i = 0; i <= 260; i++) {
  const t = i / 260;
  const u = -pw / 2 - 46 + t * (pw + 92);
  const v = 150 + Math.sin(t * 8.4) * 58 - t * 46;
  marks.push(pagePx(u, v));
}
scrawl(marks, 17, [0xe0, 0x33, 0x3a]);

// A quick tick, the kind you leave in a margin.
scrawl([[cx0 + 92, cy0 - 212], [cx0 + 126, cy0 - 172], [cx0 + 196, cy0 - 258]],
  13, [0x22, 0x8b, 0xe6]);

// ---------------------------------------------------------------- encode
const table = [...Array(256)].map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xFFFFFFFF;
  for (const v of b) c = table[(c ^ v) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6;

const out = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(buf)),
  chunk('IEND', Buffer.alloc(0)),
]));

const set = path.join(path.dirname(out), 'icon.iconset');
fs.rmSync(set, { recursive: true, force: true });
fs.mkdirSync(set, { recursive: true });
for (const sz of [16, 32, 64, 128, 256, 512]) {
  for (const [suffix, px] of [['', sz], ['@2x', sz * 2]]) {
    execFileSync('sips', ['-z', String(px), String(px), out,
      '--out', path.join(set, `icon_${sz}x${sz}${suffix}.png`)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o',
  path.join(path.dirname(out), 'icon.icns')], { stdio: 'ignore' });
fs.rmSync(set, { recursive: true, force: true });
console.log('build/icon.png and build/icon.icns written');
