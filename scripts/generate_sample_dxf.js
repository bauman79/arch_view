// data/DXF_RULES.md 규약에 따른 샘플 배치도 DXF 생성 스크립트.
// 실행: node scripts/generate_sample_dxf.js
// 출력: data/sample_site.dxf (그대로 public/sample_site.dxf로 복사되어 앱에서 로드됨)
//
// 단위는 mm(한국 AutoCAD 실무 기본값) — HEADER에 $INSUNITS=4를 명시해
// 프로그램이 자동으로 mm→m 변환하는지 검증할 수 있게 한다. 정북 = +Y.
// 좌표는 이해하기 쉽게 m 단위로 설계한 뒤 마지막에 일괄 ×1000 해서 mm로 출력한다.

import { writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DATA = join(__dirname, "..", "data", "sample_site.dxf");
const OUT_PUBLIC = join(__dirname, "..", "public", "sample_site.dxf");

/** 도면 좌표 단위 — mm 출력을 위해 m 설계값에 곱하는 배율 */
const MM_PER_M = 1000;

// ---------- DXF 그룹코드 빌더 ----------

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

/** closed=true면 LWPOLYLINE closed flag(70=1), false면 열린 폴리라인(70=0). 좌표는 m → mm로 변환해 기록 */
function polyline(layer, color, vertices, closed) {
  code(0, "LWPOLYLINE");
  code(8, layer);
  code(62, color);
  code(90, vertices.length);
  code(70, closed ? 1 : 0);
  for (const v of vertices) {
    code(10, (v.x * MM_PER_M).toFixed(1));
    code(20, (v.y * MM_PER_M).toFixed(1));
  }
}

/**
 * 창면 표시용 열린 2점 LWPOLYLINE — AutoCAD 2013+(AC1027) 형식처럼 버텍스마다
 * vertex ID(그룹코드 91)를 기록한다. dxf-parser 내장 파서가 코드 91에서 버텍스
 * 파싱을 중단하던 버그(src/dxf-lwpolyline.ts 교체본으로 수정)의 회귀 검증용.
 */
function winPolyline(layer, color, a, b) {
  code(0, "LWPOLYLINE");
  code(8, layer);
  code(62, color);
  code(90, 2);
  code(70, 0);
  code(10, (a.x * MM_PER_M).toFixed(1));
  code(20, (a.y * MM_PER_M).toFixed(1));
  code(91, 1);
  code(10, (b.x * MM_PER_M).toFixed(1));
  code(20, (b.y * MM_PER_M).toFixed(1));
  code(91, 2);
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
  ADJ_BOUNDARY: 2, // 노랑
  ROAD_CL: 4, // 하늘색
  PARK_BOUNDARY: 3, // 초록
  PLAN_BLDG: 7, // 흰색
  ADJ_BLDG: 6, // 자홍
  PLAN_WIN: 6, // 자홍(창면 표시선)
  ADJ_WIN: 6,
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

// 대지 경계선 — 100m × 80m, 원점 중심
polyline("SITE_BOUNDARY", COLOR.SITE_BOUNDARY, rectVertices(0, 0, 100, 80), true);

// 계획주동 — 판상형 2개(55m×12m, 15층) + 탑상형 1개(15m×15m, 10층).
// plan1은 대지 북측 가까이(북측 벽 y=35) 배치해 대지 밖 인접건물과의 이격을 좁게 만든다
// — 정북일조(M2)·채광사선(M3)이 실제로 "위반"을 보여주는 사례를 만들기 위함.
const plan1 = rectVertices(-20, 29, 55, 12); // y: 23~35
const plan2 = rectVertices(-20, -10, 55, 12);
const plan3 = rectVertices(25, 0, 15, 15);
polyline("PLAN_A_1", COLOR.PLAN_BLDG, plan1, true);
polyline("PLAN_A_2", COLOR.PLAN_BLDG, plan2, true);
polyline("PLAN_B_1_10F", COLOR.PLAN_BLDG, plan3, true);

// 계획주동 창면 표시 — 판상형 2개 동의 남측 벽(0→1 에지)에 채광창이 있다고 가정,
// footprint 에지와 정확히 같은 좌표로 그려야 프로그램이 매칭한다 (허용오차 0.1m).
// plan1은 LINE, plan2는 AC1027+ 스타일 LWPOLYLINE(vertex ID 포함) — 두 형식 모두 검증
line("PLAN_WIN", COLOR.PLAN_WIN, plan1[0], plan1[1]);
winPolyline("PLAN_WIN", COLOR.PLAN_WIN, plan2[0], plan2[1]);

// 인접대지경계선 — 서측 + 북측 (대지 바깥, 열린 폴리라인 1개: 서측→북측)
polyline(
  "ADJ_BOUNDARY",
  COLOR.ADJ_BOUNDARY,
  [
    { x: -60, y: -45 },
    { x: -60, y: 85 },
    { x: 60, y: 85 },
  ],
  false,
);

// 도로 중심선 — 남측
line("ROAD_CL", COLOR.ROAD_CL, { x: -60, y: -55 }, { x: 60, y: -55 });

// 인접건물 — 대지 북측 바깥(대지 북측 경계 y=40보다 북쪽), 5층 2개동.
// D동은 plan1(북측 벽 y=35) 바로 북쪽 8m 거리에 두어 정북일조(M2, 동짓날 태양 차폐)·
// 채광사선(M3, H/D=42/8=5.25>4.0)이 실제로 "위반"을 보여주도록 배치한다.
// E동은 plan3(탑상형)에서 충분히 떨어뜨려 "적합" 사례로 대비시킨다.
const adjD = rectVertices(-20, 50.5, 30, 15); // 남측 벽 y=43 (plan1 북측 y=35에서 8m, 대지 밖)
const adjE = rectVertices(20, 67.5, 30, 15); // 남측 벽 y=60 (plan3 북측 y=7.5에서 52.5m — 적합)
polyline("ADJ_BLDG_5F", COLOR.ADJ_BLDG, adjD, true);
polyline("ADJ_BLDG_5F", COLOR.ADJ_BLDG, adjE, true);

// 인접건물 창면 — D동만 남측 벽(0→1 에지, 채광창 검토 대상 — plan1을 바라보는 쪽)에
// 창이 있다고 가정. E동은 ADJ_WIN을 그리지 않아 "창 데이터 미지정 → 하위호환으로
// 전체 남향 벽 검토" 사례를 보여준다.
line("ADJ_WIN", COLOR.ADJ_WIN, adjD[0], adjD[1]);

code(0, "ENDSEC");
code(0, "EOF");

const text = lines.join("\n") + "\n";
writeFileSync(OUT_DATA, text, "utf-8");
copyFileSync(OUT_DATA, OUT_PUBLIC);

console.log(`샘플 DXF 생성 완료(mm, $INSUNITS=4): ${OUT_DATA}`);
console.log(`앱 로드용으로 복사: ${OUT_PUBLIC}`);
