import { footprintCentroid, worldFootprint } from "./buildings";
import { pointInPolygon } from "./geom2d";
import { sitePolygons } from "./groundshadow";
import { footprintAreaM2 } from "./massing";
import type { Building, Point2, Project } from "./types";

/**
 * 신속통합기획식 텐트형 층수 배분 — 대지 가운데(경계에서 가장 깊은 곳)가 가장 높고 가장자리로
 * 갈수록 낮아지며(깊이 = 경계에서의 거리와 무리 중심에서의 거리를 반반), 가장자리 높이는 주변 건물 층수에 맞춘다. 목표 용적률 또는 세대수를 채우는
 * 가장 낮은 최고층(peak)을 이분 탐색으로 찾고, 동마다 법규 최대 층수(정북·채광·인동)로 자른다.
 *
 *   층수_i = 가장자리_i + (peak − 가장자리_i) × 깊이_i^γ   (깊이 0=경계, 1=가장 안쪽)
 *
 * 연면적 = Σ 동 바닥면적 × 주거층수 + 근생 + 부대복리(세대당 ㎡ × 세대수) — 개략 산정.
 * 세대수 = 평형 구성(층당 세대)이 있는 동은 그대로, 없는 동은 바닥면적 ÷ 세대당 면적으로 추정.
 */

export interface TentOptions {
  target: { kind: "far" | "units"; value: number };
  /** 근린생활시설 연면적 (㎡) */
  retailM2: number;
  /** 부대복리시설 세대당 면적 (㎡/세대) */
  amenityPerUnit: number;
  maxFloors: number;
  minFloors: number;
  /** 가장자리 층수 = 주변 건물 최고 층수 × 이 배수 (주변이 없으면 최저층) */
  edgeFactor: number;
  /** 주변 건물을 볼 반경 (m) */
  edgeRadius: number;
  /** 텐트 곡률 γ — 1이면 직선, 크면 가운데만 뾰족 */
  shape: number;
  /** 평형 구성이 없는 동의 세대당 바닥면적(공용 포함, ㎡) */
  areaPerUnit: number;
}

export function defaultTentOptions(siteAreaM2: number): TentOptions {
  return {
    target: { kind: "far", value: 300 },
    retailM2: Math.round(Math.max(0, siteAreaM2) * 0.03),
    amenityPerUnit: 3,
    maxFloors: 35,
    minFloors: 7,
    edgeFactor: 1.5,
    edgeRadius: 100,
    shape: 1,
    areaPerUnit: 110,
  };
}

export interface TentRow {
  id: string;
  name: string;
  /** 대지 경계에서의 깊이 (0~1) */
  depth: number;
  edgeFloors: number;
  /** 텐트 모양대로라면 */
  ideal: number;
  legalMax: number;
  floors: number;
  /** 법규로 잘렸는가 */
  capped: boolean;
}

export interface TentResult {
  rows: TentRow[];
  peak: number;
  units: number;
  residentialM2: number;
  grossM2: number;
  farPct: number | null;
  amenityM2: number;
  meets: boolean;
  /** 목표 대비 (용적률 %p 또는 세대) — 음수면 부족 */
  gap: number;
}

/** 동별 층당 세대 (평형 구성이 없으면 바닥면적으로 추정) */
export function unitsPerFloorOf(b: Building, areaPerUnit: number): number {
  const mix = b.unitMix.reduce((s, m) => s + Math.max(0, Math.round(m.countPerFloor)), 0);
  if (mix > 0) return mix * Math.max(1, b.segments);
  return Math.max(1, Math.floor(footprintAreaM2(b) / Math.max(30, areaPerUnit)));
}

function distToEdges(p: Point2, poly: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** 동마다 대지 경계에서의 깊이(0~1) — 대지경계가 없으면 계획동 무리 중심에서의 거리로 */
export function depthsOf(project: Project, plans: Building[]): Map<string, number> {
  const sites = sitePolygons(project.siteOverlays);
  const cs = plans.map((b) => ({ id: b.id, c: footprintCentroid(worldFootprint(b)) }));
  const raw = new Map<string, number>();
  if (sites.length) {
    for (const { id, c } of cs) {
      const inside = sites.filter((s) => pointInPolygon(c.x, c.y, s));
      raw.set(id, inside.length ? Math.max(...inside.map((s) => distToEdges(c, s))) : 0);
    }
  } else {
    const mx = cs.reduce((s, x) => s + x.c.x, 0) / Math.max(1, cs.length);
    const my = cs.reduce((s, x) => s + x.c.y, 0) / Math.max(1, cs.length);
    const far = Math.max(1, ...cs.map((x) => Math.hypot(x.c.x - mx, x.c.y - my)));
    for (const { id, c } of cs) raw.set(id, far - Math.hypot(c.x - mx, c.y - my));
  }
  const maxD = Math.max(1e-6, ...raw.values());
  // 길쭉한 대지는 경계 거리만으로는 가운데 띠 전체가 같은 깊이가 된다 — 무리 중심에서의
  // 거리도 반반 섞어 봉우리가 하나(가운데)가 되게 한다
  const mx = cs.reduce((s, x) => s + x.c.x, 0) / Math.max(1, cs.length);
  const my = cs.reduce((s, x) => s + x.c.y, 0) / Math.max(1, cs.length);
  const far = Math.max(1e-6, ...cs.map((x) => Math.hypot(x.c.x - mx, x.c.y - my)));
  return new Map(
    cs.map(({ id, c }) => [
      id,
      0.5 * (Math.max(0, raw.get(id)!) / maxD) + 0.5 * (1 - Math.hypot(c.x - mx, c.y - my) / far),
    ]),
  );
}

/** 가장자리 층수 — 반경 안 주변 건물 최고 층수 × 배수 */
export function edgeFloorsOf(project: Project, b: Building, o: TentOptions): number {
  const c = footprintCentroid(worldFootprint(b));
  let maxAdj = 0;
  for (const a of project.buildings) {
    if (a.type !== "인접건물") continue;
    const ac = footprintCentroid(worldFootprint(a));
    if (Math.hypot(ac.x - c.x, ac.y - c.y) <= o.edgeRadius) maxAdj = Math.max(maxAdj, a.floors);
  }
  const e = maxAdj > 0 ? Math.round(maxAdj * o.edgeFactor) : o.minFloors;
  return Math.min(o.maxFloors, Math.max(o.minFloors, e));
}

export function planTent(project: Project, legalMax: Map<string, number>, o: TentOptions): TentResult {
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  const depth = depthsOf(project, plans);
  const edges = new Map(plans.map((b) => [b.id, edgeFloorsOf(project, b, o)]));
  const upf = new Map(plans.map((b) => [b.id, unitsPerFloorOf(b, o.areaPerUnit)]));
  const site = project.site.siteAreaM2;

  const floorsAt = (peak: number) =>
    plans.map((b) => {
      const e = Math.min(edges.get(b.id)!, peak);
      const w = depth.get(b.id) ?? 0;
      const ideal = Math.round(e + Math.max(0, peak - e) * Math.pow(w, o.shape));
      const minF = Math.max(o.minFloors, b.pilotiFloors + 1);
      const lm = legalMax.get(b.id) ?? o.maxFloors;
      const f = Math.max(Math.min(minF, lm), Math.min(ideal, lm, o.maxFloors));
      return { b, ideal, f, lm };
    });
  const evalAt = (peak: number) => {
    const fs = floorsAt(peak);
    let units = 0;
    let res = 0;
    for (const { b, f } of fs) {
      const rf = Math.max(0, f - Math.min(f, b.pilotiFloors));
      units += upf.get(b.id)! * rf;
      res += footprintAreaM2(b) * rf;
    }
    const amenity = units * o.amenityPerUnit;
    const gross = res + o.retailM2 + amenity;
    const far = site > 0 ? (gross / site) * 100 : null;
    const metric = o.target.kind === "units" ? units : far ?? 0;
    return { fs, units, res, gross, far, amenity, metric };
  };

  // 목표를 채우는 가장 낮은 peak (0.25층 단위) — 지표는 peak에 대해 단조 증가
  let lo = o.minFloors, hi = o.maxFloors;
  let best = evalAt(hi);
  if (best.metric >= o.target.value) {
    while (hi - lo > 0.25) {
      const mid = (lo + hi) / 2;
      const r = evalAt(mid);
      if (r.metric >= o.target.value) {
        hi = mid;
        best = r;
      } else lo = mid;
    }
  }
  const peak = Math.max(...best.fs.map((x) => x.f));
  return {
    rows: best.fs.map(({ b, ideal, f, lm }) => ({
      id: b.id,
      name: b.name,
      depth: depth.get(b.id) ?? 0,
      edgeFloors: edges.get(b.id)!,
      ideal,
      legalMax: lm,
      floors: f,
      capped: ideal > lm,
    })),
    peak,
    units: best.units,
    residentialM2: best.res,
    grossM2: best.gross,
    farPct: best.far,
    amenityM2: best.amenity,
    meets: best.metric >= o.target.value,
    gap: best.metric - o.target.value,
  };
}

/** 정해진 층수로 세대수·연면적·용적률 (planTent와 같은 산식) */
export function tentMetrics(
  project: Project,
  floors: Map<string, number>,
  o: TentOptions,
): { units: number; residentialM2: number; grossM2: number; farPct: number | null; amenityM2: number; meets: boolean; gap: number } {
  let units = 0;
  let res = 0;
  for (const b of project.buildings) {
    if (b.type !== "계획주동") continue;
    const f = floors.get(b.id) ?? b.floors;
    const rf = Math.max(0, f - Math.min(f, b.pilotiFloors));
    units += unitsPerFloorOf(b, o.areaPerUnit) * rf;
    res += footprintAreaM2(b) * rf;
  }
  const amenity = units * o.amenityPerUnit;
  const gross = res + o.retailM2 + amenity;
  const site = project.site.siteAreaM2;
  const far = site > 0 ? (gross / site) * 100 : null;
  const metric = o.target.kind === "units" ? units : far ?? 0;
  return { units, residentialM2: res, grossM2: gross, farPct: far, amenityM2: amenity, meets: metric >= o.target.value, gap: metric - o.target.value };
}
