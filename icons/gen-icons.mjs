// Génère les icônes de l'extension (PNG 16/32/48/128) sans dépendance externe :
// loupe blanche sur carré arrondi bleu (#0969da — l'accent de la popup/palette),
// même géométrie que le SEARCH_ICON de l'UI. Rendu vectoriel maison avec
// anti-aliasing par supersampling, encodage PNG via zlib (node:zlib).
//
// Usage : node icons/gen-icons.mjs  (depuis la racine du repo)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [16, 32, 48, 128];
const SS = 4; // subsamples par axe (16 échantillons / pixel)

const BLUE = [9, 105, 218]; // #0969da
const WHITE = [255, 255, 255];

/* ─── Géométrie (coordonnées normalisées 0..1, comme le viewBox 16 de l'UI) ─── */
// SEARCH_ICON : circle cx=7 cy=7 r=4.6, handle 10.6,10.6 → 13.8,13.8 (sur 16)
const LENS = { cx: 7 / 16, cy: 7 / 16, r: 4.2 / 16, w: 1.7 / 16 };
const HANDLE = { x1: 10.2 / 16, y1: 10.2 / 16, x2: 13.0 / 16, y2: 13.0 / 16, w: 1.9 / 16 };
const CORNER = 0.22; // rayon des coins du carré, en fraction du côté

function roundedRectDist(x, y, half, corner) {
  // distance signée au carré arrondi centré en (0.5, 0.5)
  const qx = Math.abs(x - 0.5) - (half - corner);
  const qy = Math.abs(y - 0.5) - (half - corner);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - corner;
}

function ringDist(x, y) {
  return Math.abs(Math.hypot(x - LENS.cx, y - LENS.cy) - LENS.r) - LENS.w / 2;
}

function segmentDist(x, y) {
  const { x1, y1, x2, y2, w } = HANDLE;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - w / 2; // cap rond
}

function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const aa = 0.7 / (size * SS); // largeur de transition (~1 subpixel) pour l'anti-aliasing
  const smooth = (d) => Math.min(1, Math.max(0, 0.5 - d / (2 * aa)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let glyph = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const inBg = smooth(roundedRectDist(u, v, 0.5, CORNER));
          bg += inBg;
          glyph += inBg * smooth(Math.min(ringDist(u, v), segmentDist(u, v)));
        }
      }
      bg /= SS * SS;
      glyph /= SS * SS;
      const i = (y * size + x) * 4;
      // bleu de fond, loupe blanche par-dessus, alpha = couverture du carré arrondi
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BLUE[c] + (WHITE[c] - BLUE[c]) * (bg ? glyph / bg : 0));
      px[i + 3] = Math.round(bg * 255);
    }
  }
  return px;
}

/* ─── Encodage PNG (RGBA 8 bits, filtre 0) ─── */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1)); // 1 octet de filtre par scanline
  for (let y = 0; y < size; y++) {
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
for (const size of SIZES) {
  const file = join(here, `icon${size}.png`);
  writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`${file} écrit`);
}
