import { signedArea } from "./geom2d";
import type { Building, MassType, Point2, UnitMixEntry } from "./types";

/**
 * M6 — 주동 타입 템플릿 + 세대수 자동산출 (plan.md 4장 주동 타입 템플릿, 5장 7항).
 * 태양·레이캐스팅과 무관한 결정적 계산만 담는다 — sun.ts / insolation.ts 를
 * 참조하지 않는다.
 */

// ---------- 템플릿 기본값 ----------

/** 세대 1호 폭 (m) — 판상형·분절형 장변 길이 = 층당 세대 × 이 값 */
export const UNIT_WIDTH = 11;
/** 판상형·분절형 깊이 (m) */
export const SLAB_DEPTH = 12;
/** 분절형 인접 분절 간 꺾임 각 (도) */
export const SEGMENT_BEND_DEG = 30;
/** 탑상형 층당 세대당 바닥면적 근사 (㎡ — 전용 84㎡ 위주 + 공용부) */
export const TOWER_AREA_PER_UNIT = 135;

/** 타입별 층당 세대 수 기본값 (plan.md: 판상 4~6, 탑상 2~4 → M6 요구: 판상 4, 탑상 6) */
export const DEFAULT_UNITS_PER_FLOOR: Record<MassType, number> = {
  slab: 4,
  tower: 6,
  segment: 4,
  custom: 4,
};

export const MASS_TYPE_LABEL: Record<MassType, string> = {
  slab: "판상형",
  tower: "탑상형",
  segment: "분절형",
  custom: "custom",
};

/** 평형 구성비 초기 시드값(59/84/101㎡ = 50/30/20%) — defaultUnitMix()가 절대 세대수로 환산해 쓴다 */
const DEFAULT_UNIT_MIX_RATIO: { unitType: string; ratio: number }[] = [
  { unitType: "59㎡", ratio: 50 },
  { unitType: "84㎡", ratio: 30 },
  { unitType: "101㎡", ratio: 20 },
];

/**
 * 신규 건물 생성 시 평형별 **층당** 세대수 초기값 — 층당세대(unitsPerFloor)를
 * 50/30/20 비율로 배분한다. 총 세대수는 unitBreakdown()이 층수·필로티·분절 변경마다
 * 매번 새로 계산하므로(countPerFloor × 주거층수 × 분절), 층수를 바꾸면 자동 반영된다.
 */
export function defaultUnitMix(unitsPerFloor: number): UnitMixEntry[] {
  return distributeUnits(
    Math.max(0, Math.round(unitsPerFloor)),
    DEFAULT_UNIT_MIX_RATIO,
  ).map((c) => ({ unitType: c.unitType, countPerFloor: c.count }));
}

// ---------- 세대수 ----------

/** 주거층수 = 총 층수 − 필로티 층수 (필로티는 층수 이하로 클램프) — 연면적(GFA)·세대수 계산에 쓰인다 */
export function residentialFloors(b: Building): number {
  return Math.max(0, b.floors - Math.min(b.pilotiFloors, b.floors));
}

export interface UnitCount {
  unitType: string;
  count: number;
}

/**
 * 총량을 구성비대로 배분 — 최대잉여법(largest remainder):
 * 내림 후 소수부가 큰 순서로 1개씩 추가해 합계가 반드시 total과 일치한다.
 * (단순 반올림은 합계가 어긋날 수 있음) — defaultUnitMix 시드값 계산에 쓰인다.
 */
export function distributeUnits(
  total: number,
  mix: { unitType: string; ratio: number }[],
): UnitCount[] {
  const ratios = mix.map((m) => Math.max(0, m.ratio));
  const sum = ratios.reduce((s, r) => s + r, 0);
  if (total <= 0 || sum <= 0) {
    return mix.map((m) => ({ unitType: m.unitType, count: 0 }));
  }
  const exact = ratios.map((r) => (total * r) / sum);
  const counts = exact.map(Math.floor);
  let rest = total - counts.reduce((s, c) => s + c, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - counts[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rest; k++) counts[order[k].i]++;
  return mix.map((m, i) => ({ unitType: m.unitType, count: counts[i] }));
}

/** 건물 1동의 타입별 세대수 = 층당세대수 × 주거층수 × 분절 수 — 층수·필로티 변경 시 자동 재계산 */
export function unitBreakdown(b: Building): UnitCount[] {
  const floors = residentialFloors(b) * Math.max(1, b.segments);
  return b.unitMix.map((m) => ({
    unitType: m.unitType,
    count: Math.max(0, Math.round(m.countPerFloor)) * floors,
  }));
}

/** 건물 1동의 총 세대수 */
export function totalUnits(b: Building): number {
  return unitBreakdown(b).reduce((s, u) => s + u.count, 0);
}

export interface SiteUnitTotals {
  /** 세대수 산출 대상(계획주동, unitsPerFloor > 0) 동 수 */
  buildingCount: number;
  total: number;
  byType: UnitCount[];
}

/** 전체 사이트 세대수 합계 — 동별 배분(최대잉여) 결과를 합산해 카드 표시와 일치시킨다 */
export function siteUnitTotals(buildings: Building[]): SiteUnitTotals {
  const byType = new Map<string, number>();
  let total = 0;
  let count = 0;
  for (const b of buildings) {
    if (b.type !== "계획주동" || b.unitsPerFloor <= 0) continue;
    count++;
    total += totalUnits(b);
    for (const u of unitBreakdown(b)) {
      byType.set(u.unitType, (byType.get(u.unitType) ?? 0) + u.count);
    }
  }
  return {
    buildingCount: count,
    total,
    byType: [...byType].map(([unitType, c]) => ({ unitType, count: c })),
  };
}

// ---------- 면적·건폐율·용적률 ----------

/** offset 회전·이동은 면적을 바꾸지 않으므로 원본 footprint로 계산 */
export function footprintAreaM2(b: Building): number {
  return Math.abs(signedArea(b.footprint));
}

/** 연면적 근사 = footprint 면적 × 주거층수 (필로티 층은 바닥면적 산입 제외 근사) */
export function grossFloorAreaM2(b: Building): number {
  return footprintAreaM2(b) * residentialFloors(b);
}

export interface CoverageStats {
  /** Σ 계획주동 footprint 면적 (㎡) */
  coverageM2: number;
  /** Σ 계획주동 연면적 (㎡) */
  grossM2: number;
  /** 건폐율 (%) — 대지면적 미입력이면 null */
  bcrPct: number | null;
  /** 용적률 (%) — 대지면적 미입력이면 null */
  farPct: number | null;
}

/** 건폐율·용적률 — 계획주동만 산입 (인접건물은 타 대지) */
export function coverageStats(
  buildings: Building[],
  siteAreaM2: number,
): CoverageStats {
  let coverageM2 = 0;
  let grossM2 = 0;
  for (const b of buildings) {
    if (b.type !== "계획주동") continue;
    coverageM2 += footprintAreaM2(b);
    grossM2 += grossFloorAreaM2(b);
  }
  const ok = siteAreaM2 > 0;
  return {
    coverageM2,
    grossM2,
    bcrPct: ok ? (coverageM2 / siteAreaM2) * 100 : null,
    farPct: ok ? (grossM2 / siteAreaM2) * 100 : null,
  };
}

// ---------- 타입 템플릿 footprint 생성 ----------

/**
 * 주동 타입 템플릿 footprint (원점 중심, CCW).
 * - slab: 장방형 — 폭 = 층당 세대 × UNIT_WIDTH, 깊이 SLAB_DEPTH
 * - tower: 정방형 코어 중심 — 면적 ≈ 층당 세대 × TOWER_AREA_PER_UNIT
 * - segment: 판상형 분절을 SEGMENT_BEND_DEG씩 꺾어 연결 (부채꼴 배열)
 */
export function templateFootprint(
  massType: Exclude<MassType, "custom">,
  unitsPerFloor: number,
  segments: number,
): Point2[] {
  const upf = Math.max(1, unitsPerFloor);
  if (massType === "tower") {
    const side = Math.sqrt(upf * TOWER_AREA_PER_UNIT);
    const h = side / 2;
    return [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h },
    ];
  }
  const nSeg = massType === "segment" ? Math.max(2, segments) : 1;
  return bentSlabFootprint(upf * UNIT_WIDTH, SLAB_DEPTH, nSeg, SEGMENT_BEND_DEG);
}

/**
 * 중심선 경로(분절마다 bendDeg씩 방향이 꺾임)를 depth 폭으로 양쪽 오프셋(miter join)해
 * 닫힌 CCW 폴리곤을 만든다. segments=1이면 단순 장방형과 동일.
 */
function bentSlabFootprint(
  segLen: number,
  depth: number,
  segments: number,
  bendDeg: number,
): Point2[] {
  const bend = (bendDeg * Math.PI) / 180;
  // 중심선 경로 — 분절 k의 진행 방향을 부채꼴로 분산해 전체가 대칭이 되게 한다
  const path: Point2[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (let k = 0; k < segments; k++) {
    const heading = (k - (segments - 1) / 2) * bend;
    x += Math.cos(heading) * segLen;
    y += Math.sin(heading) * segLen;
    path.push({ x, y });
  }

  const half = depth / 2;
  const left: Point2[] = [];
  const right: Point2[] = [];
  for (let i = 0; i < path.length; i++) {
    const dIn = i > 0 ? unitVec(path[i - 1], path[i]) : unitVec(path[0], path[1]);
    const dOut =
      i < path.length - 1 ? unitVec(path[i], path[i + 1]) : dIn;
    // 진행방향의 왼쪽 법선
    const nIn = { x: -dIn.y, y: dIn.x };
    const nOut = { x: -dOut.y, y: dOut.x };
    let mx = nIn.x + nOut.x;
    let my = nIn.y + nOut.y;
    const ml = Math.hypot(mx, my);
    mx /= ml;
    my /= ml;
    // miter 길이 보정 (급격한 꺾임 폭주 방지용 하한)
    const scale = half / Math.max(0.3, mx * nIn.x + my * nIn.y);
    left.push({ x: path[i].x + mx * scale, y: path[i].y + my * scale });
    right.push({ x: path[i].x - mx * scale, y: path[i].y - my * scale });
  }
  // 아래변(오른쪽) 정방향 + 위변(왼쪽) 역방향 = CCW
  const poly = [...right, ...left.reverse()];

  // 원점 중심으로 재배치
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

function unitVec(a: Point2, b: Point2): Point2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}

// ---------- 템플릿 Building 생성 ----------

let tmplSeq = 0;

/** 타입 템플릿으로 계획주동 생성. seq는 이름 번호(같은 타입 몇 번째인지) */
export function createTemplateBuilding(
  massType: Exclude<MassType, "custom">,
  unitsPerFloor: number,
  segments: number,
  seq: number,
): Building {
  const nSeg = massType === "segment" ? Math.max(2, segments) : 1;
  return {
    id: `tmpl-${++tmplSeq}-${Date.now().toString(36)}`,
    name: `${MASS_TYPE_LABEL[massType]} ${seq}`,
    type: "계획주동",
    massType,
    footprint: templateFootprint(massType, unitsPerFloor, nSeg),
    floors: 15,
    floorHeight: 2.8,
    pilotiFloors: 0,
    unitsPerFloor: Math.max(1, unitsPerFloor),
    segments: nSeg,
    unitMix: defaultUnitMix(Math.max(1, unitsPerFloor)),
    offset: { dx: 0, dy: 0, rotation: 0 },
    // PV(M4/M5) 잠재량 분석 대상 = 계획주동(태양광은 우리가 짓는 건물의 지붕·창없는 벽에 검토)
    analysisTarget: true,
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

/** 건물 카드·합계용 세대수 표기: "총 36세대 (59㎡ 18 / 84㎡ 11 / 101㎡ 7)" */
export function unitSummaryText(total: number, byType: UnitCount[]): string {
  if (total <= 0) return "세대수 산출 대상 아님";
  const parts = byType
    .filter((u) => u.count > 0 || byType.length <= 3)
    .map((u) => `${u.unitType} ${u.count}`)
    .join(" / ");
  return parts ? `총 ${total}세대 (${parts})` : `총 ${total}세대`;
}
