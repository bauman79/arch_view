import { footprintCentroid, worldFootprint } from "./buildings";
import { pointInPolygon, polygonPolygonClosest } from "./geom2d";
import { sitePolygons } from "./groundshadow";
import { footprintAreaM2 } from "./massing";
import { violations, type LegalOpt } from "./maxfloors";
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
  /** 가장자리 층수 = 주변 건물 층수 × 이 배수 */
  edgeFactor: number;
  /** 주변 건물 층수 최소 가정 — 인접건물이 없거나 이보다 낮으면 이 층수로 본다 */
  assumedAdjFloors: number;
  /** 주변 건물을 볼 반경 (m) */
  edgeRadius: number;
  /** 텐트 곡률 γ — 1이면 직선, 크면 가운데만 뾰족 */
  shape: number;
  /** 평형 구성이 없는 동의 세대당 바닥면적(공용 포함, ㎡) */
  areaPerUnit: number;
  /** 남저북고 비중 (0 = 가운데 높은 텐트만, 1 = 북쪽일수록 높게만) */
  northWeight: number;
  /** 탑상형 판정 — 바닥면적 이상 (㎡) */
  towerMinArea: number;
  /** 탑상형 판정 — 가로세로비 이하 */
  towerMaxAspect: number;
  /** 판상형·날개 동 층수 = 탑상형 기준 층수 × 이 비율 */
  slabRatio: number;
  /** 높이 단계 (층) — 이 단위로 맞춘다. 0이면 단계 없음 */
  tierStep: number;
  /** 목표를 못 채우면 낮은 동을 끌어올리는 것을 허용 (스카이라인 규칙 완화) */
  allowRelax?: boolean;
  /** 정북·채광사선은 상층부 셋백으로 대응 — 층수 제한에서 제외 */
  skipSetback?: boolean;
  /** 인동거리 여유 (%) — 기준의 이만큼 모자라도 허용 */
  spacingTolPct?: number;
}

export function legalOptOf(o: TentOptions): LegalOpt {
  return { skipSetback: o.skipSetback ?? false, spacingTol: (o.spacingTolPct ?? 0) / 100 };
}

export type MassRole = "탑상" | "판상" | "날개";

/** 최소 외접 사각형 기준 긴 변 / 짧은 변 */
export function aspectOf(fp: Point2[]): number {
  const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
  const cy = fp.reduce((s, p) => s + p.y, 0) / fp.length;
  let best = { area: Infinity, asp: 1 };
  for (let k = 0; k < 90; k += 2) {
    const th = (k * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of fp) {
      const u = (p.x - cx) * c + (p.y - cy) * sn, v = -(p.x - cx) * sn + (p.y - cy) * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const w = x1 - x0, h = y1 - y0;
    if (w * h < best.area) best = { area: w * h, asp: Math.max(w, h) / Math.max(1e-6, Math.min(w, h)) };
  }
  return best.asp;
}

/**
 * 동 역할 — 탑상형(크고 정방형에 가까움)은 고층, 탑에 붙은 작은 동은 날개, 나머지는 판상(중저층).
 * 붙음 = 외곽선 간격 1m 이내. 날개는 붙은 탑 중 가장 큰 것을 따른다.
 */
export function massRoles(plans: Building[], o: TentOptions): Map<string, { role: MassRole; tower?: string }> {
  const fps = new Map(plans.map((b) => [b.id, worldFootprint(b)]));
  const isTower = (b: Building) => footprintAreaM2(b) >= o.towerMinArea && aspectOf(b.footprint) <= o.towerMaxAspect;
  const out = new Map<string, { role: MassRole; tower?: string }>();
  const towers = plans.filter(isTower);
  for (const b of plans) {
    if (isTower(b)) {
      out.set(b.id, { role: "탑상" });
      continue;
    }
    let host: Building | null = null;
    for (const t of towers) {
      if (polygonPolygonClosest(fps.get(b.id)!, fps.get(t.id)!).distance <= 1.0) {
        if (!host || footprintAreaM2(t) > footprintAreaM2(host)) host = t;
      }
    }
    out.set(b.id, host ? { role: "날개", tower: host.id } : { role: "판상" });
  }
  return out;
}

/** 진북 방향 위치 (0 = 가장 남쪽, 1 = 가장 북쪽) */
export function northnessOf(project: Project, plans: Building[]): Map<string, number> {
  const th = (project.site.northAngle * Math.PI) / 180;
  const N = { x: -Math.sin(th), y: Math.cos(th) };
  const v = plans.map((b) => {
    const c = footprintCentroid(worldFootprint(b));
    return [b.id, c.x * N.x + c.y * N.y] as const;
  });
  const lo = Math.min(...v.map(([, x]) => x)), hi = Math.max(...v.map(([, x]) => x));
  return new Map(v.map(([id, x]) => [id, hi - lo > 1e-6 ? (x - lo) / (hi - lo) : 0.5]));
}

export function defaultTentOptions(siteAreaM2: number): TentOptions {
  return {
    target: { kind: "far", value: 300 },
    retailM2: Math.round(Math.max(0, siteAreaM2) * 0.03),
    amenityPerUnit: 3,
    maxFloors: 35,
    minFloors: 7,
    edgeFactor: 1,
    assumedAdjFloors: 10,
    edgeRadius: 100,
    shape: 1,
    areaPerUnit: 110,
    northWeight: 0.5,
    towerMinArea: 400,
    towerMaxAspect: 1.4,
    slabRatio: 0.6,
    tierStep: 5,
    skipSetback: true,
    spacingTolPct: 10,
  };
}

export interface TentRow {
  id: string;
  name: string;
  /** 대지 경계에서의 깊이 (0~1) */
  depth: number;
  /** 남저북고·텐트를 섞은 높이 점수 (0~1) */
  score: number;
  role: MassRole;
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
  /** 최고층까지 올려도 모자라 낮은 동을 바닥층(lift)까지 끌어올렸는가 — 텐트 완화 */
  relaxedLift: number | null;
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

/** 가장자리 층수 — max(반경 안 주변 건물 최고 층수, 가정 층수) × 배수 */
export function edgeFloorsOf(project: Project, b: Building, o: TentOptions): number {
  const c = footprintCentroid(worldFootprint(b));
  let maxAdj = 0;
  for (const a of project.buildings) {
    if (a.type !== "인접건물") continue;
    const ac = footprintCentroid(worldFootprint(a));
    if (Math.hypot(ac.x - c.x, ac.y - c.y) <= o.edgeRadius) maxAdj = Math.max(maxAdj, a.floors);
  }
  const adj = Math.max(maxAdj, o.assumedAdjFloors ?? 0);
  const e = adj > 0 ? Math.round(adj * o.edgeFactor) : o.minFloors;
  return Math.min(o.maxFloors, Math.max(o.minFloors, e));
}

export function planTent(project: Project, legalMax: Map<string, number>, o: TentOptions): TentResult {
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  const depth = depthsOf(project, plans);
  const north = northnessOf(project, plans);
  const nw = Math.min(1, Math.max(0, o.northWeight ?? 0));
  const raw0 = new Map(plans.map((b) => [b.id, (1 - nw) * (depth.get(b.id) ?? 0) + nw * (north.get(b.id) ?? 0.5)]));
  // 가장 높은 자리가 1이 되도록 다시 맞춤 — 섞으면 최고점이 1보다 작아 최고층에 못 닿는다
  const sMin = Math.min(...raw0.values()), sMax = Math.max(...raw0.values());
  const score = new Map([...raw0].map(([id, v]) => [id, sMax - sMin > 1e-9 ? (v - sMin) / (sMax - sMin) : 1]));
  const roles = massRoles(plans, { ...o, towerMinArea: o.towerMinArea ?? 0, towerMaxAspect: o.towerMaxAspect ?? 99 });
  const ratio = o.slabRatio ?? 1;
  const tier = o.tierStep ?? 0;
  const snap = (f: number) => (tier > 0 ? Math.max(tier, Math.round(f / tier) * tier) : Math.round(f));
  const edges = new Map(plans.map((b) => [b.id, edgeFloorsOf(project, b, o)]));
  const upf = new Map(plans.map((b) => [b.id, unitsPerFloorOf(b, o.areaPerUnit)]));
  const site = project.site.siteAreaM2;

  /** lift: 텐트 완화 — 모든 동을 최소 이 층까지 (법규 한도 안에서) 끌어올림 */
  /** 텐트(+남저북고) 기준 층수 — 탑상형 기준 */
  const towerIdeal = (id: string, peak: number) => {
    const e = Math.min(edges.get(id)!, peak);
    return e + Math.max(0, peak - e) * Math.pow(score.get(id) ?? 0, o.shape);
  };
  const floorsAt = (peak: number, lift = 0) =>
    plans.map((b) => {
      const r = roles.get(b.id)!;
      // 탑상형은 텐트 높이, 날개는 붙은 탑의 비율, 판상형은 자기 자리 텐트 높이의 비율
      const raw =
        r.role === "탑상" ? towerIdeal(b.id, peak)
        : r.role === "날개" ? towerIdeal(r.tower!, peak) * ratio
        : towerIdeal(b.id, peak) * ratio;
      const ideal = snap(raw);
      const minF = Math.max(o.minFloors, b.pilotiFloors + 1);
      const lm = legalMax.get(b.id) ?? o.maxFloors;
      const f = Math.max(Math.min(minF, lm), Math.min(Math.max(ideal, Math.round(lift)), lm, o.maxFloors));
      return { b, ideal, f, lm };
    });
  const evalAt = (peak: number, lift = 0) => {
    const fs = floorsAt(peak, lift);
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
  let relaxedLift: number | null = null;
  if (best.metric >= o.target.value) {
    while (hi - lo > 0.25) {
      const mid = (lo + hi) / 2;
      const r = evalAt(mid);
      if (r.metric >= o.target.value) {
        hi = mid;
        best = r;
      } else lo = mid;
    }
  } else {
    // 최고층까지 세워도 모자라면 텐트를 완화 — 낮은 동부터 법규 한도까지 끌어올린다
    // (가운데가 가장 높은 순서는 유지, 목표를 채우는 가장 낮은 바닥층 lift를 찾는다)
    let a = o.minFloors, z = o.maxFloors;
    const top = evalAt(o.maxFloors, z);
    best = top;
    relaxedLift = z;
    if (top.metric >= o.target.value) {
      while (z - a > 0.5) {
        const mid = (a + z) / 2;
        const r = evalAt(o.maxFloors, mid);
        if (r.metric >= o.target.value) {
          z = mid;
          best = r;
          relaxedLift = mid;
        } else a = mid;
      }
    }
    relaxedLift = Math.round(relaxedLift);
  }
  const peak = Math.max(...best.fs.map((x) => x.f));
  return {
    rows: best.fs.map(({ b, ideal, f, lm }) => ({
      id: b.id,
      name: b.name,
      depth: depth.get(b.id) ?? 0,
      score: score.get(b.id) ?? 0,
      role: roles.get(b.id)!.role,
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
    relaxedLift,
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

// ---------- 우선순위 법규 맞춤 (높아야 할 동이 인동거리 여유를 먼저 차지) ----------

interface RulePlan {
  plans: Building[];
  meta: Map<string, { score: number; role: MassRole; edge: number; depth: number }>;
  /** peak·lift에서 동별 규칙 층수 (법규 미적용) */
  floorsAt(peak: number, lift: number): Map<string, number>;
}

export function prepareRule(project: Project, o: TentOptions): RulePlan {
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  const depth = depthsOf(project, plans);
  const north = northnessOf(project, plans);
  const nw = Math.min(1, Math.max(0, o.northWeight ?? 0));
  const raw0 = new Map(plans.map((b) => [b.id, (1 - nw) * (depth.get(b.id) ?? 0) + nw * (north.get(b.id) ?? 0.5)]));
  // 가장 높은 자리가 1이 되도록 다시 맞춤 — 섞으면 최고점이 1보다 작아 최고층에 못 닿는다
  const sMin = Math.min(...raw0.values()), sMax = Math.max(...raw0.values());
  const score = new Map([...raw0].map(([id, v]) => [id, sMax - sMin > 1e-9 ? (v - sMin) / (sMax - sMin) : 1]));
  const roles = massRoles(plans, o);
  const edges = new Map(plans.map((b) => [b.id, edgeFloorsOf(project, b, o)]));
  const tier = o.tierStep ?? 0;
  const snap = (f: number) => (tier > 0 ? Math.max(tier, Math.round(f / tier) * tier) : Math.round(f));
  const towerIdeal = (id: string, peak: number) => {
    const e = Math.min(edges.get(id)!, peak);
    return e + Math.max(0, peak - e) * Math.pow(score.get(id) ?? 0, o.shape);
  };
  return {
    plans,
    meta: new Map(plans.map((b) => [b.id, { score: score.get(b.id)!, role: roles.get(b.id)!.role, edge: edges.get(b.id)!, depth: depth.get(b.id)! }])),
    floorsAt(peak, lift) {
      const out = new Map<string, number>();
      for (const b of plans) {
        const r = roles.get(b.id)!;
        const raw = r.role === "탑상" ? towerIdeal(b.id, peak) : r.role === "날개" ? towerIdeal(r.tower!, peak) * o.slabRatio : towerIdeal(b.id, peak) * o.slabRatio;
        const minF = Math.max(o.minFloors, b.pilotiFloors + 1);
        out.set(b.id, Math.min(o.maxFloors, Math.max(minF, snap(raw), Math.round(lift))));
      }
      return out;
    },
  };
}

/**
 * 규칙 층수를 법규에 맞춘다 — 우선순위(규칙 층수 높은 동 → 높이 점수 높은 동) 순서로, 앞선 동은
 * 정해진 층수, 뒤 동은 최소 층수로 둔 채 그 동의 규칙 층수 이하 최대 적합 층수를 이분 탐색.
 * 최소 층수에서도 걸리는 위반(높이와 무관)은 기준선으로 빼고 새 위반만 막는다.
 */
export async function legalizeByPriority(
  project: Project,
  rp: RulePlan,
  want: Map<string, number>,
  yieldFn: () => Promise<void> = () => Promise.resolve(),
  opt: LegalOpt = {},
): Promise<Map<string, number>> {
  const sim = { ...project, buildings: project.buildings.map((b) => ({ ...b })) } as Project;
  const byId = new Map(sim.buildings.map((b) => [b.id, b]));
  const ids = rp.plans.map((b) => b.id);
  const minOf = (b: Building) => Math.max(1, b.pilotiFloors + 1);
  for (const id of ids) byId.get(id)!.floors = minOf(byId.get(id)!);
  const plansSim = ids.map((id) => byId.get(id)!);
  const base = new Map(ids.map((id) => [id, violations(sim, byId.get(id)!, plansSim, opt)]));
  const order = [...ids].sort(
    (a, b) => want.get(b)! - want.get(a)! || rp.meta.get(b)!.score - rp.meta.get(a)!.score,
  );
  const out = new Map<string, number>();
  let k = 0;
  for (const id of order) {
    const b = byId.get(id)!;
    const bs = base.get(id)!;
    const ok = () => {
      for (const key of violations(sim, b, plansSim, opt).keys()) if (!bs.has(key)) return false;
      return true;
    };
    let lo = minOf(b), hi = Math.max(lo, want.get(id)!);
    b.floors = hi;
    if (!ok()) {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        b.floors = mid;
        if (ok()) lo = mid;
        else hi = mid;
      }
      b.floors = lo;
    }
    out.set(id, b.floors);
    if (++k % 4 === 0) await yieldFn();
  }
  return out;
}

export interface TentLegalResult extends TentResult {
  relaxedLift: number | null;
}

/**
 * 규칙(텐트·남저북고·탑상/판상·단계) + 우선순위 법규 맞춤으로 목표를 채우는 가장 낮은 peak를 찾는다.
 * peak = 최고층 한도에서도 모자라면 낮은 동을 lift까지 끌어올린다(우선순위는 유지).
 */
export async function planTentLegal(
  project: Project,
  o: TentOptions,
  onProgress?: (msg: string) => void,
  yieldFn: () => Promise<void> = () => Promise.resolve(),
): Promise<TentLegalResult> {
  const rp = prepareRule(project, o);
  const evalAt = async (peak: number, lift: number) => {
    const want = rp.floorsAt(peak, lift);
    const got = await legalizeByPriority(project, rp, want, yieldFn, legalOptOf(o));
    const m = tentMetrics(project, got, o);
    return { want, got, m, metric: o.target.kind === "units" ? m.units : m.farPct ?? 0 };
  };
  let step = 0;
  const say = (t: string) => onProgress?.(`${t} (${++step})`);
  say("최고층 한도로 확인");
  let best = await evalAt(o.maxFloors, 0);
  let relaxedLift: number | null = null;
  if (best.metric >= o.target.value) {
    let lo = o.minFloors, hi = o.maxFloors;
    while (hi - lo > 1) {
      const mid = Math.round((lo + hi) / 2);
      say(`최고 ${mid}층 텐트 검토`);
      const r = await evalAt(mid, 0);
      if (r.metric >= o.target.value) {
        hi = mid;
        best = r;
      } else lo = mid;
    }
  } else if (o.allowRelax) {
    let lo = o.minFloors, hi = o.maxFloors;
    say("텐트 완화 — 낮은 동 끌어올림");
    const top = await evalAt(o.maxFloors, hi);
    if (top.metric >= o.target.value) {
      best = top;
      relaxedLift = hi;
      while (hi - lo > 1) {
        const mid = Math.round((lo + hi) / 2);
        say(`낮은 동 ${mid}층까지 검토`);
        const r = await evalAt(o.maxFloors, mid);
        if (r.metric >= o.target.value) {
          hi = mid;
          best = r;
          relaxedLift = mid;
        } else lo = mid;
      }
    } else {
      best = top.metric > best.metric ? top : best;
      relaxedLift = top === best ? o.maxFloors : null;
    }
  }
  const rows: TentRow[] = rp.plans.map((b) => {
    const mt = rp.meta.get(b.id)!;
    const ideal = best.want.get(b.id)!;
    const f = best.got.get(b.id)!;
    return { id: b.id, name: b.name, depth: mt.depth, score: mt.score, role: mt.role, edgeFloors: mt.edge, ideal, legalMax: f, floors: f, capped: f < ideal };
  });
  return {
    rows,
    peak: Math.max(...rows.map((r) => r.floors)),
    units: best.m.units,
    residentialM2: best.m.residentialM2,
    grossM2: best.m.grossM2,
    farPct: best.m.farPct,
    amenityM2: best.m.amenityM2,
    meets: best.m.meets,
    gap: best.m.gap,
    relaxedLift,
  };
}
