// data/CONTOUR_RULES.md 규약에 따른 M7 지형 샘플 DXF 생성 스크립트.
// 실행: node scripts/generate_sample_terrain_dxf.js
// 출력: data/sample_terrain.dxf
//
// 구성: 200×200m 대지(SITE_BOUNDARY) + 5m 간격 등고선(0~25m, 북쪽으로 상승)
// + 계획주동 2동(PLAN_A_1/PLAN_A_2 — 저지대/고지대에 나눠 배치해 G.L. 차이 확인용).
// 등고선 0~20m는 레이어명 접미사(CONTOUR_0 … CONTOUR_20) 방식, 25m 한 가닥은
// LWPOLYLINE elevation(그룹코드 38, 도면 단위 mm) 방식 — 두 고도 지정 경로 모두 검증.
//
// 단위는 mm(한국 AutoCAD 실무 기본값) — HEADER에 $INSUNITS=4. 정북 = +Y.
// 좌표는 m 단위로 설계한 뒤 마지막에 일괄 ×1000 해서 mm로 출력한다.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DATA = join(__dirname, "..", "data", "sample_terrain.dxf");

/** 도면 좌표 단위 — mm 출력을 위해 m 설계값에 곱하는 배율 */
const MM_PER_M = 1000;

// ---------- DXF 그룹코드 빌더 (generate_sample_dxf.js와 동일 규약) ----------

const lines = [];

function code(n, v) {
  lines.push(String(n), String(v));
}

function rectVertices(cx, cy, w, d) {
  const hw = w / 2;
  const hd = d / 2;
  // 순서: 좌하 → 우하 → 우상 → 좌상 (CCW). 0→1 에지가 남측 벽.
  return [
    { x: cx - hw, y: cy - hd },
    { x: cx + hw, y: cy - hd },
    { x: cx + hw, y: cy + hd },
    { x: cx - hw, y: cy + hd },
  ];
}

/** closed=true면 closed flag(70=1). elevationM을 주면 그룹코드 38(도면 단위 mm)로 기록 */
function polyline(layer, color, vertices, closed, elevationM) {
  code(0, "LWPOLYLINE");
  code(8, layer);
  code(62, color);
  code(90, vertices.length);
  code(70, closed ? 1 : 0);
  if (elevationM !== undefined) code(38, (elevationM * MM_PER_M).toFixed(1));
  for (const v of vertices) {
    code(10, (v.x * MM_PER_M).toFixed(1));
    code(20, (v.y * MM_PER_M).toFixed(1));
  }
}

function line(layer, color, a, b) {
  code(0, "LINE");
  code(8, layer);
  code(62, color);
  code(10, (a.x * MM_PER_M).toFixed(1));
  code(20, (a.y * MM_PER_M).toFixed(1));
  code(30, "0");
  code(11, (b.x * MM_PER_M).toFixed(1));
  code(21, (b.y * MM_PER_M).toFixed(1));
  code(31, "0");
}

// ---------- 레이어 색상 (data/DXF_RULES.md 표 참고) ----------
const COLOR = {
  SITE_BOUNDARY: 1, // 빨강
  PLAN_BLDG: 7, // 흰색
  PLAN_WIN: 6, // 자홍(창면 표시선)
  CONTOUR: 8, // 회색
};

// ---------- HEADER ($INSUNITS=4: mm) ----------

code(0, "SECTION");
code(2, "HEADER");
code(9, "$INSUNITS");
code(70, "4");
code(0, "ENDSEC");

// ---------- 배치 (설계는 m 단위, 출력 시 mm로 변환) ----------

code(0, "SECTION");
code(2, "ENTITIES");

// 대지 경계선 — 200m × 200m, 원점 중심 (x, y: -100 ~ +100)
polyline("SITE_BOUNDARY", COLOR.SITE_BOUNDARY, rectVertices(0, 0, 200, 200), true);

// 등고선 — 남쪽 0m에서 북쪽 25m까지 5m 간격으로 상승하는 완만한 북사면.
// 기준선 y = -100 + 8×(고도m) 에 사인 굴곡을 더해 자연스러운 TIN을 만든다.
// 대지 경계보다 살짝 넓게(x: -110~110) 그려서 경계 클리핑 후에도 가장자리가 비지 않게 한다.
function contourVertices(elev) {
  const baseY = -100 + 8 * elev;
  const pts = [];
  for (let x = -110; x <= 110; x += 10) {
    // 고도별로 위상을 어긋나게 해 등고선끼리 평행하지 않게 (교차는 하지 않는 진폭)
    const y = baseY + 6 * Math.sin(x / 35 + elev / 5) + 3 * Math.sin(x / 90 - elev / 7);
    pts.push({ x, y });
  }
  return pts;
}

// 0~20m: 레이어명 접미사 방식 (CONTOUR_0 … CONTOUR_20)
for (const elev of [0, 5, 10, 15, 20]) {
  polyline(`CONTOUR_${elev}`, COLOR.CONTOUR, contourVertices(elev), false);
}
// 25m: LWPOLYLINE elevation(그룹코드 38 = 25000mm) 방식 — 접미사 없는 CONTOUR 레이어
polyline("CONTOUR", COLOR.CONTOUR, contourVertices(25), false, 25);

// 계획주동 — 같은 타입(합동) 판상형 40m×12m 2동을 저지대/고지대에 나눠 배치.
// A_1(남측, G.L.≈5m 부근)과 A_2(북측, G.L.≈18m 부근)의 지반고 차이를 3D에서 확인.
const planA1 = rectVertices(-30, -55, 40, 12);
const planA2 = rectVertices(25, 45, 40, 12);
polyline("PLAN_A_1", COLOR.PLAN_BLDG, planA1, true);
polyline("PLAN_A_2", COLOR.PLAN_BLDG, planA2, true);

// 창면 표시 — 두 동 모두 남측 벽(0→1 에지)에 채광창 가정
line("PLAN_WIN", COLOR.PLAN_WIN, planA1[0], planA1[1]);
line("PLAN_WIN", COLOR.PLAN_WIN, planA2[0], planA2[1]);

code(0, "ENDSEC");
code(0, "EOF");

const text = lines.join("\n") + "\n";
writeFileSync(OUT_DATA, text, "utf-8");

console.log(`지형 샘플 DXF 생성 완료(mm, $INSUNITS=4): ${OUT_DATA}`);
