import { signedArea } from "./geom2d";
import type { AreaTable, AreaTableRow, Building, MassType, Point2, UnitMixEntry } from "./types";

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
    // 평형 숫자순(39 → 59 → 84 → 101)으로 — 도면에 나온 순서대로면 표가 뒤섞여 읽기 어렵다.
    // 숫자가 아닌 이름은 원래 순서를 지킨 채 뒤로 보낸다.
    byType: [...byType]
      .map(([unitType, c], i) => ({ unitType, count: c, i, n: parseFloat(unitType) }))
      .sort((a, b) =>
        Number.isNaN(a.n) || Number.isNaN(b.n)
          ? (Number.isNaN(a.n) ? 1 : 0) - (Number.isNaN(b.n) ? 1 : 0) || a.i - b.i
          : a.n - b.n,
      )
      .map(({ unitType, count }) => ({ unitType, count })),
  };
}

/** 계획주동 이름 "계획주동_A_1" → 타입 "A" */
export function planTypeOf(name: string): string {
  const m = name.match(/_([A-Za-z0-9]+)_\d+(?:-\d+)?$/);
  return m ? m[1].toUpperCase() : "기타";
}

/** 동의 타입 — 지정된 planType 우선, 없으면 이름에서 */
export function planTypeOfBuilding(b: { name: string; planType?: string }): string {
  return b.planType ?? planTypeOf(b.name);
}

export interface UnitBand {
  label: string;
  count: number;
  /** 전체 세대 대비 % */
  pct: number;
}

/**
 * 전용면적 규모별 세대 비율 — 60㎡ 이하(소형) / 60~85㎡ / 85㎡ 초과(국민주택규모 초과).
 * 평형 이름에서 숫자를 못 읽으면 "규모 미상".
 */
export function unitSizeBands(t: SiteUnitTotals): UnitBand[] {
  const bands = [
    { label: "60㎡ 이하", count: 0 },
    { label: "60㎡ 초과 85㎡ 이하", count: 0 },
    { label: "85㎡ 초과", count: 0 },
    { label: "규모 미상", count: 0 },
  ];
  for (const u of t.byType) {
    const n = parseFloat(u.unitType);
    const k = Number.isNaN(n) ? 3 : n <= 60 ? 0 : n <= 85 ? 1 : 2;
    bands[k].count += u.count;
  }
  return bands
    .filter((b, i) => i < 3 || b.count > 0)
    .map((b) => ({ ...b, pct: t.total > 0 ? (b.count / t.total) * 100 : 0 }));
}

/** 동 타입별 동수·세대수 (타입 이름순) */
export function planTypeTotals(buildings: Building[]): { type: string; dongs: number; units: number }[] {
  const m = new Map<string, { dongs: number; units: number }>();
  for (const b of buildings) {
    if (b.type !== "계획주동") continue;
    const k = planTypeOfBuilding(b);
    const e = m.get(k) ?? { dongs: 0, units: 0 };
    e.dongs++;
    e.units += b.unitsPerFloor > 0 ? totalUnits(b) : 0;
    m.set(k, e);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([type, e]) => ({ type, ...e }));
}

// ---------- 면적·건폐율·용적률 ----------

/** offset 회전·이동은 면적을 바꾸지 않으므로 원본 footprint로 계산 */
export function footprintAreaM2(b: Building): number {
  return Math.abs(signedArea(b.footprint));
}

/**
 * 기본 면적표 — 서울 신통기획 공동주택 개략 면적표 예(전용 + 주거공용 = 공급). 사용자가 면적표 엑셀을
 * 불러오거나 직접 고치면 그 값으로 바뀐다.
 */
export const DEFAULT_AREA_ROWS: AreaTableRow[] = [
  { type: 39, exclusiveM2: 39.96, commonM2: 17.65 },
  { type: 49, exclusiveM2: 49.96, commonM2: 19.65 },
  { type: 59, exclusiveM2: 59.98, commonM2: 22.65 },
  { type: 74, exclusiveM2: 74.98, commonM2: 26.95 },
  { type: 84, exclusiveM2: 84.97, commonM2: 29.25 },
  { type: 109, exclusiveM2: 109.97, commonM2: 30.65 },
];

/**
 * 평형 이름(예: "84㎡")의 세대당 공급면적. 면적표에 같은 숫자 평형이 있으면 그 값,
 * 없으면 전용 = 평형 숫자로 보고 주거공용은 가까운 두 평형 사이 선형 보간(양끝은 끝값). 숫자가 아니면 null.
 */
export function supplyAreaOf(unitType: string, rows: AreaTableRow[]): number | null {
  const n = parseFloat(unitType);
  if (!Number.isFinite(n) || n <= 0) return null;
  const sorted = [...rows].filter((r) => r.type > 0).sort((a, b) => a.type - b.type);
  if (!sorted.length) return null;
  const hit = sorted.find((r) => Math.abs(r.type - n) < 0.5);
  if (hit) return hit.exclusiveM2 + hit.commonM2;
  let common: number;
  if (n <= sorted[0].type) common = sorted[0].commonM2;
  else if (n >= sorted[sorted.length - 1].type) common = sorted[sorted.length - 1].commonM2;
  else {
    const i = sorted.findIndex((r) => r.type > n);
    const a = sorted[i - 1], b = sorted[i];
    common = a.commonM2 + ((n - a.type) / (b.type - a.type)) * (b.commonM2 - a.commonM2);
  }
  return n + common;
}

/**
 * 한 층 주거 바닥면적 — 면적표를 켜고 동에 평형 구성이 있으면 Σ(층당 세대 × 공급면적),
 * 아니면 외곽선 면적(발코니 등이 들어가 실제 면적표보다 크게 나온다).
 */
export function residentialFloorAreaM2(b: Building, table?: AreaTable): number {
  if (table?.enabled && b.unitMix.length > 0) {
    let s = 0;
    for (const m of b.unitMix) {
      const a = supplyAreaOf(m.unitType, table.rows);
      if (a === null) return footprintAreaM2(b);
      s += a * Math.max(0, m.countPerFloor);
    }
    if (s > 0) return s * Math.max(1, b.segments);
  }
  return footprintAreaM2(b);
}

/** 주거 연면적 = 한 층 주거 바닥면적 × 주거층수 (필로티 층 제외) */
export function grossFloorAreaM2(b: Building, table?: AreaTable): number {
  return residentialFloorAreaM2(b, table) * residentialFloors(b);
}

export interface CoverageStats {
  /** Σ 계획주동 footprint 면적 (㎡) */
  coverageM2: number;
  /** 용적률 산정 연면적 (㎡) = 주거 + 근생·부대 */
  grossM2: number;
  /** 주거 연면적 (㎡) = Σ 바닥면적 × 주거층수 */
  residentialM2: number;
  /** 근생 + 부대복리 (㎡) */
  extraM2: number;
  /** 건폐율 (%) — 대지면적 미입력이면 null */
  bcrPct: number | null;
  /** 용적률 (%) — 대지면적 미입력이면 null */
  farPct: number | null;
}

/** 건폐율·용적률 — 계획주동만 산입 (인접건물은 타 대지) */
export function coverageStats(
  buildings: Building[],
  siteAreaM2: number,
  extra?: { retailM2: number; amenityPerUnit: number; areaTable?: AreaTable },
): CoverageStats {
  let coverageM2 = 0;
  let residentialM2 = 0;
  for (const b of buildings) {
    if (b.type !== "계획주동") continue;
    coverageM2 += footprintAreaM2(b);
    residentialM2 += grossFloorAreaM2(b, extra?.areaTable);
  }
  const extraM2 = extra
    ? Math.max(0, extra.retailM2) + Math.max(0, extra.amenityPerUnit) * siteUnitTotals(buildings).total
    : 0;
  const grossM2 = residentialM2 + extraM2;
  const ok = siteAreaM2 > 0;
  return {
    coverageM2,
    grossM2,
    residentialM2,
    extraM2,
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
