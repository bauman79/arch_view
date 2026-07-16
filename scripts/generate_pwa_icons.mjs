// PWA 아이콘 생성 — 외부 이미지 도구 없이 순수 Node(zlib)로 PNG를 인코딩한다.
// 디자인: 툴바 색(#0F1929) 배경 + 앰버(#E0921A) 주동 3동 + 태양 — 앱 테마와 동일.
// 실행: node scripts/generate_pwa_icons.mjs  →  public/icon-192.png · icon-512.png · icon.svg
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---------- PNG 인코더 (8bit RGBA, 필터 0) ----------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(size*size*4) → PNG Buffer */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 스캔라인마다 필터 바이트 0을 앞에 붙인다
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 그리기 (512 기준 좌표 → size로 스케일) ----------

const BG = [0x0f, 0x19, 0x29]; // 툴바 색
const AMBER = [0xe0, 0x92, 0x1a]; // 액센트
const AMBER_LIGHT = [0xf0, 0xa5, 0x2e];
const NAVY_LINE = [0x2a, 0x3f, 0x66];

function drawIcon(size) {
  const s = size / 512; // 512 기준 좌표 스케일
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  // 배경 (maskable 대응 — 여백 없이 전체 채움, 콘텐츠는 중앙 80% 안)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++)
      for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++)
        set(x, y, color);
  };
  const circle = (cx, cy, r, color) => {
    const r2 = r * r * s * s;
    const [Cx, Cy] = [cx * s, cy * s];
    for (let y = Math.floor((cy - r) * s); y <= Math.ceil((cy + r) * s); y++)
      for (let x = Math.floor((cx - r) * s); x <= Math.ceil((cx + r) * s); x++) {
        const dx = x + 0.5 - Cx;
        const dy = y + 0.5 - Cy;
        if (dx * dx + dy * dy <= r2 && x >= 0 && y >= 0 && x < size && y < size)
          set(x, y, color);
      }
  };

  // 태양 (우상단)
  circle(392, 138, 46, AMBER_LIGHT);
  // 주동 3동 (높이 다르게)
  rect(92, 240, 168, 430, AMBER);
  rect(196, 160, 272, 430, AMBER_LIGHT);
  rect(300, 296, 376, 430, AMBER);
  // 지면선
  rect(72, 430, 440, 442, NAVY_LINE);
  return encodePng(size, px);
}

for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`✓ ${file}`);
}

// SVG 아이콘 (파비콘·manifest "any" 용) — 같은 디자인
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0F1929"/>
  <circle cx="392" cy="138" r="46" fill="#F0A52E"/>
  <rect x="92" y="240" width="76" height="190" fill="#E0921A"/>
  <rect x="196" y="160" width="76" height="270" fill="#F0A52E"/>
  <rect x="300" y="296" width="76" height="134" fill="#E0921A"/>
  <rect x="72" y="430" width="368" height="12" fill="#2A3F66"/>
</svg>
`;
writeFileSync(join(OUT, "icon.svg"), svg);
console.log(`✓ ${join(OUT, "icon.svg")}`);
