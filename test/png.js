'use strict';
/** Minimal PNG decoder -- enough for qlmanage thumbnails (8-bit, non-interlaced). */
const zlib = require('zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let off = 8, ihdr = null, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: W, height: H } = ihdr;
  const bpp = channels, stride = W * bpp;
  const out = Buffer.alloc(H * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[i] = v & 0xFF;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width: W, height: H, channels, data: out };
}

/** Fraction of pixels whose RGB differs by more than `tol`. Images must match in size. */
function diffRatio(a, b, tol = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let n = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const ao = i * a.channels, bo = i * b.channels;
    const d = Math.abs(a.data[ao] - b.data[bo]) +
              Math.abs(a.data[ao + 1] - b.data[bo + 1]) +
              Math.abs(a.data[ao + 2] - b.data[bo + 2]);
    if (d > tol) n++;
  }
  return n / total;
}

/** Mean RGB of a rectangular region given in fractions of width/height. */
function regionMean(img, fx, fy, fw, fh) {
  const x0 = Math.max(0, Math.round(fx * img.width)), x1 = Math.min(img.width, Math.round((fx + fw) * img.width));
  const y0 = Math.max(0, Math.round(fy * img.height)), y1 = Math.min(img.height, Math.round((fy + fh) * img.height));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * img.channels;
    r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

module.exports = { decodePng, diffRatio, regionMean };
