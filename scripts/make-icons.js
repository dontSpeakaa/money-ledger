import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Blue gradient rounded square with a white coin carrying a "¥" glyph. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const radius = size * 0.22;
  const coinCx = 256 * s;
  const coinCy = 236 * s;
  const coinR = 128 * s;

  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const cx = Math.min(Math.max(fx, radius), size - radius);
      const cy = Math.min(Math.max(fy, radius), size - radius);
      if ((fx - cx) ** 2 + (fy - cy) ** 2 > radius ** 2) continue;
      const t = (x + y) / (2 * size);
      set(x, y, Math.round(47 + t * 76), Math.round(107 - t * 14), 255);
    }
  }

  const stroke = (x0, y0, x1, y1, w, r, g, b) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3);
    const half = w / 2;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let dy = -half; dy <= half; dy += 0.5) {
        for (let dx = -half; dx <= half; dx += 0.5) {
          if (dx * dx + dy * dy <= half * half) {
            set(Math.round(cx + dx), Math.round(cy + dy), r, g, b);
          }
        }
      }
    }
  };

  // white coin disc
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - coinCx, y + 0.5 - coinCy);
      if (d <= coinR) {
        const shade = Math.round(255 - (d / coinR) * 22);
        set(x, y, shade, shade, shade);
      }
    }
  }

  const W = 15 * s;
  stroke(coinCx - 52 * s, coinCy - 72 * s, coinCx, coinCy - 8 * s, W, 47, 107, 255);
  stroke(coinCx + 52 * s, coinCy - 72 * s, coinCx, coinCy - 8 * s, W, 47, 107, 255);
  stroke(coinCx, coinCy - 12 * s, coinCx, coinCy + 74 * s, W, 47, 107, 255);
  stroke(coinCx - 44 * s, coinCy + 14 * s, coinCx + 44 * s, coinCy + 14 * s, W * 0.85, 47, 107, 255);
  stroke(coinCx - 44 * s, coinCy + 44 * s, coinCx + 44 * s, coinCy + 44 * s, W * 0.85, 47, 107, 255);

  return px;
}

for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), encodePng(size, size, drawIcon(size)));
  console.log(`wrote icon-${size}.png`);
}
