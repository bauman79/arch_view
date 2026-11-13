import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { pointInPolygon, raySegmentDistance } from "./geom2d";
import { residentialHeight, type Building, type Point2, type Project } from "./types";
import { edgeHasWindow } from "./windows";

/**
 * 인동거리 검토 (M3) — 건축법 시행령 제86조 제3항 제2호.
 * 같은 대지의 계획주동 쌍마다 **서로 마주보는 벽면**을 찾아, 벽면 직각방향 이격거리를 판정한다.
 *
 * ⚠️ 법은 "벽면으로부터 직각방향" 거리 기준이므로, 두 벽면을 서로 직각방향으로 확장했을 때
 * 실제로 겹치는(마주보는) 경우에만 검토한다. 또 그 직각선이 **처음 만나는 동**하고만 본다 —
 * 사이에 다른 동이 끼어 있으면 그 뒤의 동은 검토하지 않는다(가려진 구간 제외).
 * 높이는 필로티를 뺀 주거층 높이(residentialHeight) — 대각선으로 어긋나 마주보지 않는 건물 쌍은
 * 검토 대상이 아니다(예전 구현이 폴리곤 최단거리로 대각선까지 판정하던 오류를 수정).
 *
 * 마주보는 벽면 쌍의 적용 기준:
 *   - 가목: 어느 한쪽이라도 채광창 있는 벽면 → 이격 ≥ spacingRatioWindow × 높은 동 높이
 *     (시행령 하한 0.5배, 서울시 조례 0.8배)
 *   - 라목: 채광창 없는 벽면 ↔ 측벽 → 8m 이상 (창없는 벽면끼리도 보수적으로 이 값 적용)
 *   - 마목: 측벽 ↔ 측벽 → 4m 이상
 *   측벽 = 동의 최소 외접 사각형 단변과 나란한 벽(장축과 60° 넘게 꺾인 벽). 측벽에 창 표시가
 *   있어도 채광창 벽면(가목)으로 보지 않는다 — 측벽은 라·마목(8m·4m)만 적용.
 *   정사각형에 가까운 탑상형(장/단변 < 1.3)은 장축이 없으므로 창 표시 없는 벽을 측벽으로 본다.
 *   나목(남측 저층·개구부 방향 특례)·다목(부대·복리시설)은 미반영(문서화된 한계).
 *
 * PLAN_WIN 창면 데이터가 없는 동(windowSegments 비어있음)은 하위호환으로 모든 벽을
 * "채광창 있음"으로 간주한다(보수적 — 가목 적용).
 *
 * ⚠️ 정북사선(northsetback.ts)·태양 계산과 완전히 독립된 순수 기하 계산 —
 * 드래그·회전 중 매 프레임 호출 가능.
 */

export type SpacingRule = "채광" | "창없음" | "측벽";

/** 마주보는 구간으로 인정할 최소 겹침 길이 (m) — 모서리만 살짝 걸치는 경우는 마주봄이 아니다 */
const MIN_OVERLAP = 1.0;
/** 가림 판정 샘플 간격 (m) */
const SAMPLE_STEP = 0.5;

interface Edge { a: Point2; b: Point2; minX: number; minY: number; maxX: number; maxY: number; plan: number; edge: number }
/** 후보 탐색용 광선 간격 (m) */
const PROBE_STEP = 1.0;
/** 후보 탐색 최대 거리 (m) — 이보다 먼 동은 인동거리 기준(최대 0.8×H)과 무관 */
const PROBE_FAR = 200;

export interface SpacingCheck {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  /** 마주보는 구간의 벽면 직각방향 최소 이격거리 (m) */
  distance: number;
  /** 기준 이격거리 (m) */
  required: number;
  /** 적용 기준 — 가목(채광)/라목(창없음)/마목(측벽) */
  rule: SpacingRule;
  /** 기준높이 (m) — 두 동 중 높은 동 (채광 규칙에서 사용) */
  height: number;
  /** 마주보는 구간 길이 (m) */
  overlapLen: number;
  pass: boolean;
  /** 최소 이격 지점 쌍 (DXF 평면, 월드 좌표) — 시각화용 */
  pa: Point2;
  pb: Point2;
}

export interface SpacingResult {
  ratioWindow: number;
  noWindowM: number;
  sideM: number;
  checks: SpacingCheck[];
  violations: number;
}

interface PlanEntry {
  id: string;
  name: string;
  building: Building;
  fp: Point2[];
  height: number;
  /** 에지별 창 유무 (windowSegments 비어있으면 전부 true — 하위호환) */
  edgeWin: boolean[];
  /** 에지별 측벽 여부 (길이 ≤ 최장 벽 × 0.5) */
  edgeSide: boolean[];
  /** 에지별 바깥 법선 (단위벡터) */
  normals: Point2[];
  /** 에지별 길이 */
  lens: number[];
}

function signedArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function mkEntry(b: Building): PlanEntry {
  const fp = worldFootprint(b);
  const n = fp.length;
  const windingSign = signedArea(fp) >= 0 ? 1 : -1;
  const lens: number[] = [];
  const normals: Point2[] = [];
  const edgeWin: boolean[] = [];
  const edgeSide: boolean[] = [];
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const p1 = fp[i];
    const p2 = fp[(i + 1) % n];
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    const len = Math.hypot(ex, ey);
    lens.push(len);
    maxLen = Math.max(maxLen, len);
    // CCW(양의 면적) 폴리곤에서 에지 진행방향의 오른쪽이 바깥
    normals.push(
      len > 1e-9
        ? { x: (windingSign * ey) / len, y: (-windingSign * ex) / len }
        : { x: 0, y: 0 },
    );
    edgeWin.push(
      b.windowSegments.length === 0
        ? true // 창 데이터 미지정 — 보수적으로 창 있음(가목) 간주
        : edgeHasWindow(b.footprint[i], b.footprint[(i + 1) % n], b.windowSegments),
    );
  }
  // 측벽 판별 — 최소 외접 사각형의 장축 방향으로 정한다. 길이로 정하면 요철이 많은 판상형의
  // 전면이 짧은 벽 여러 개로 쪼개져 측벽으로 잘못 잡힌다.
  const axis = principalAxis(fp);
  for (let i = 0; i < n; i++) {
    const ex = fp[(i + 1) % n].x - fp[i].x;
    const ey = fp[(i + 1) % n].y - fp[i].y;
    const len = lens[i];
    let side: boolean;
    if (axis && len > 1e-9) {
      // 장축과 60° 넘게 꺾인(= 단축과 나란한) 벽이 측벽
      side = Math.abs((ex * axis.x + ey * axis.y) / len) < 0.5;
    } else {
      // 정사각형에 가까운 탑상형 — 장·단변이 없으니 창 표시가 없는 벽을 측벽으로 본다
      side = b.windowSegments.length > 0 ? !edgeWin[i] : false;
    }
    edgeSide.push(side);
    // 측벽은 창이 있어도 채광창 벽면(가목)으로 보지 않는다 — 측벽은 라·마목만 적용
    if (side) edgeWin[i] = false;
  }
  void maxLen;
  return {
    id: b.id,
    name: b.name,
    building: b,
    fp,
    height: residentialHeight(b), // 필로티 제외 주거층 높이
    edgeWin,
    edgeSide,
    normals,
    lens,
  };
}

/** 정사각형 판정 기준 — 외접 사각형 장변/단변이 이보다 작으면 장축이 없다고 본다 */
const SQUARE_ASPECT = 1.3;

/** 볼록 껍질 */
function convexHull(pts: Point2[]): Point2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Point2, a: Point2, b: Point2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * 최소 면적 외접 사각형의 장축(단위벡터). 장변/단변 < SQUARE_ASPECT면 null(탑상형).
 * 볼록 껍질 각 변 방향마다 사각형을 대 보고 넓이가 가장 작은 것을 고른다.
 */
export function principalAxis(fp: Point2[]): Point2 | null {
  const h = convexHull(fp);
  if (h.length < 3) return null;
  let best: { area: number; ux: number; uy: number; w: number; d: number } | null = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-9) continue;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of h) {
      const u = q.x * ux + q.y * uy, v = -q.x * uy + q.y * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const w = maxU - minU, d = maxV - minV;
    if (!best || w * d < best.area - 1e-9) best = { area: w * d, ux, uy, w, d };
  }
  if (!best) return null;
  const long = Math.max(best.w, best.d), short = Math.min(best.w, best.d);
  if (short < 1e-9 || long / short < SQUARE_ASPECT) return null;
  return best.w >= best.d ? { x: best.ux, y: best.uy } : { x: -best.uy, y: best.ux };
}

/**
 * source의 i번째 벽면에서 직각방향으로 확장했을 때 target의 j번째 벽면과 마주보는지 판정.
 * 마주보면(겹침 ≥ MIN_OVERLAP, 겹침 구간 전체가 벽 바깥쪽) 최소 직각거리를 반환.
 */
function facingDistance(
  src: PlanEntry,
  i: number,
  tgt: PlanEntry,
  j: number,
  blockers: EdgeIndex,
): { distance: number; overlapLen: number; pSrc: Point2; pTgt: Point2 } | null {
  const na = src.normals[i];
  const nb = tgt.normals[j];
  // 법선이 서로 반대 방향 성분을 가져야 "마주보는" 벽면
  if (na.x * nb.x + na.y * nb.y >= -1e-9) return null;

  const p1 = src.fp[i];
  const p2 = src.fp[(i + 1) % src.fp.length];
  const len = src.lens[i];
  if (len < 1e-9) return null;
  const dir = { x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len };

  const q1 = tgt.fp[j];
  const q2 = tgt.fp[(j + 1) % tgt.fp.length];
  // target 끝점을 source 벽면 좌표계로: t = 벽면 방향 성분, s = 직각(바깥) 방향 성분
  const t1 = (q1.x - p1.x) * dir.x + (q1.y - p1.y) * dir.y;
  const s1 = (q1.x - p1.x) * na.x + (q1.y - p1.y) * na.y;
  const t2 = (q2.x - p1.x) * dir.x + (q2.y - p1.y) * dir.y;
  const s2 = (q2.x - p1.x) * na.x + (q2.y - p1.y) * na.y;

  // 파라미터 u∈[0,1]에서 t(u)가 [0,len]에 들어오는 구간으로 클리핑
  let uLo = 0;
  let uHi = 1;
  const dt = t2 - t1;
  // 벽면 방향과 직교하는 target — 겹침 길이 0이라 마주봄 아님
  if (Math.abs(dt) < 1e-9) return null;
  const uAt0 = (0 - t1) / dt;
  const uAtLen = (len - t1) / dt;
  uLo = Math.max(uLo, Math.min(uAt0, uAtLen));
  uHi = Math.min(uHi, Math.max(uAt0, uAtLen));
  if (uHi <= uLo) return null;

  // s ≥ 0 (벽 바깥쪽) 구간으로 추가 클리핑
  const ds = s2 - s1;
  if (Math.abs(ds) > 1e-9) {
    const uAtS0 = (0 - s1) / ds;
    if (ds > 0) uLo = Math.max(uLo, uAtS0);
    else uHi = Math.min(uHi, uAtS0);
    if (uHi <= uLo) return null;
  } else if (s1 < 0) {
    return null;
  }

  const tLo = t1 + dt * uLo;
  const tHi = t1 + dt * uHi;
  if (Math.abs(tHi - tLo) < MIN_OVERLAP) return null;

  // 마주보는 구간을 따라 직각선을 쏘아, 이 벽(j)보다 먼저 다른 벽에 막히는 지점은 뺀다
  const n = Math.min(400, Math.max(5, Math.ceil(Math.abs(tHi - tLo) / SAMPLE_STEP) + 1));
  const inset = Math.min(1e-3, Math.abs(tHi - tLo) * 1e-3);
  let visible = 0;
  let best: { s: number; u: number } | null = null;
  for (let k = 0; k < n; k++) {
    const u = uLo + inset / Math.abs(dt) + ((uHi - uLo) - (2 * inset) / Math.abs(dt)) * (k / (n - 1));
    const s = s1 + ds * u;
    if (s < 0) continue;
    const t = t1 + dt * u;
    const o = { x: p1.x + dir.x * t, y: p1.y + dir.y * t };
    if (blocked(o, na, s, blockers)) continue;
    visible++;
    if (!best || s < best.s) best = { s, u };
  }
  if (!best) return null;
  const overlapLen = Math.abs(tHi - tLo) * (visible / n);
  if (overlapLen < MIN_OVERLAP) return null;

  const pTgt = { x: q1.x + (q2.x - q1.x) * best.u, y: q1.y + (q2.y - q1.y) * best.u };
  const pSrc = { x: pTgt.x - na.x * best.s, y: pTgt.y - na.y * best.s };
  return { distance: best.s, overlapLen, pSrc, pTgt };
}

const INDEX_CELL = 8;

/** 벽 선분 격자 색인 — 가림 판정 때 근처 벽만 검사한다 (드래그 중 매 프레임 호출) */
class EdgeIndex {
  private cells = new Map<number, Edge[]>();
  private key(cx: number, cy: number): number { return (cx + 50000) * 100000 + (cy + 50000); }
  constructor(edges: Edge[]) {
    for (const e of edges) {
      for (let cx = Math.floor(e.minX / INDEX_CELL); cx <= Math.floor(e.maxX / INDEX_CELL); cx++) {
        for (let cy = Math.floor(e.minY / INDEX_CELL); cy <= Math.floor(e.maxY / INDEX_CELL); cy++) {
          const k = this.key(cx, cy);
          const l = this.cells.get(k);
          if (l) l.push(e); else this.cells.set(k, [e]);
        }
      }
    }
  }
  cell(cx: number, cy: number): Edge[] | undefined { return this.cells.get(this.key(cx, cy)); }
  /** 사각형 범위에 걸친 벽들 (중복 가능) */
  query(minX: number, minY: number, maxX: number, maxY: number, out: Set<Edge>): void {
    out.clear();
    for (let cx = Math.floor(minX / INDEX_CELL); cx <= Math.floor(maxX / INDEX_CELL); cx++) {
      for (let cy = Math.floor(minY / INDEX_CELL); cy <= Math.floor(maxY / INDEX_CELL); cy++) {
        const l = this.cells.get(this.key(cx, cy));
        if (l) for (const e of l) out.add(e);
      }
    }
  }
}

const queryBuf = new Set<Edge>();

/** o에서 dir로 거리 s 안에 다른 벽(어느 계획주동이든)이 있으면 가려진 것 */
function blocked(o: Point2, dir: Point2, s: number, index: EdgeIndex): boolean {
  const ex = o.x + dir.x * s, ey = o.y + dir.y * s;
  const minX = Math.min(o.x, ex) - 1e-6, maxX = Math.max(o.x, ex) + 1e-6;
  const minY = Math.min(o.y, ey) - 1e-6, maxY = Math.max(o.y, ey) + 1e-6;
  const lim = s - Math.max(1e-6, s * 1e-6);
  index.query(minX, minY, maxX, maxY, queryBuf);
  for (const e of queryBuf) {
    if (e.maxX < minX || e.minX > maxX || e.maxY < minY || e.minY > maxY) continue;
    const d = raySegmentDistance(o, dir, e.a, e.b);
    if (d !== null && d > 1e-6 && d < lim) return true;
  }
  return false;
}

function edgesOf(plans: PlanEntry[]): Edge[] {
  const out: Edge[] = [];
  plans.forEach((p, pi) => {
    for (let i = 0; i < p.fp.length; i++) {
      const a = p.fp[i], b = p.fp[(i + 1) % p.fp.length];
      out.push({ a, b, minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), plan: pi, edge: i });
    }
  });
  return out;
}

/** 격자를 따라가며(DDA) 광선이 처음 만나는 벽 */
function firstHit(o: Point2, dir: Point2, index: EdgeIndex, maxD: number): { e: Edge; d: number } | null {
  let cx = Math.floor(o.x / INDEX_CELL), cy = Math.floor(o.y / INDEX_CELL);
  const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dir.x) < 1e-12 ? Infinity : INDEX_CELL / Math.abs(dir.x);
  const tDeltaY = Math.abs(dir.y) < 1e-12 ? Infinity : INDEX_CELL / Math.abs(dir.y);
  const nextX = (cx + (stepX > 0 ? 1 : 0)) * INDEX_CELL, nextY = (cy + (stepY > 0 ? 1 : 0)) * INDEX_CELL;
  let tMaxX = Math.abs(dir.x) < 1e-12 ? Infinity : (nextX - o.x) / dir.x;
  let tMaxY = Math.abs(dir.y) < 1e-12 ? Infinity : (nextY - o.y) / dir.y;
  let best: { e: Edge; d: number } | null = null;
  let tCell = 0;
  while (tCell <= maxD) {
    const list = index.cell(cx, cy);
    if (list) {
      for (const e of list) {
        const d = raySegmentDistance(o, dir, e.a, e.b);
        if (d !== null && d > 1e-6 && (!best || d < best.d)) best = { e, d };
      }
    }
    const tExit = Math.min(tMaxX, tMaxY);
    if (best && best.d <= tExit) return best;
    tCell = tExit;
    if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; } else { cy += stepY; tMaxY += tDeltaY; }
  }
  return best && best.d <= maxD ? best : null;
}

/** 각 벽에서 직각으로 광선을 쏘아 처음 닿는 (다른 동의) 벽 — 실제로 검토할 벽면 쌍 후보 */
function facingCandidates(plans: PlanEntry[], index: EdgeIndex): Map<number, [number, number, number, number][]> {
  /** 키 = 작은 동 번호 × 10000 + 큰 동 번호 → [원천 동, 원천 벽, 대상 동, 대상 벽] */
  const out = new Map<number, [number, number, number, number][]>();
  const seen = new Set<string>();
  plans.forEach((p, pi) => {
    for (let i = 0; i < p.fp.length; i++) {
      const len = p.lens[i];
      if (len < MIN_OVERLAP) continue;
      const a = p.fp[i], b = p.fp[(i + 1) % p.fp.length];
      const n = p.normals[i];
      const k = Math.max(1, Math.round(len / PROBE_STEP));
      for (let s = 0; s < k; s++) {
        const t = (s + 0.5) / k;
        const o = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const h = firstHit(o, n, index, PROBE_FAR);
        if (!h || h.e.plan === pi) continue;
        const key = `${pi}:${i}>${h.e.plan}:${h.e.edge}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pk = Math.min(pi, h.e.plan) * 10000 + Math.max(pi, h.e.plan);
        const l = out.get(pk);
        const item: [number, number, number, number] = [pi, i, h.e.plan, h.e.edge];
        if (l) l.push(item); else out.set(pk, [item]);
      }
    }
  });
  return out;
}

/** 벽면 쌍의 적용 기준과 요구 이격거리 */
function ruleFor(
  src: PlanEntry,
  i: number,
  tgt: PlanEntry,
  j: number,
  ratioWindow: number,
  noWindowM: number,
  sideM: number,
): { rule: SpacingRule; required: number } {
  const winSrc = src.edgeWin[i];
  const winTgt = tgt.edgeWin[j];
  const height = Math.max(src.height, tgt.height);
  // 가목: 어느 한쪽이 채광창 있는 벽면(측벽 제외)이면 0.5H — 측벽에서는 비율 거리를 보지 않는다
  if (winSrc || winTgt) return { rule: "채광", required: height * ratioWindow };
  // 마목: 측벽 ↔ 측벽 4m
  if (src.edgeSide[i] && tgt.edgeSide[j]) return { rule: "측벽", required: sideM };
  // 라목: 채광창 없는 벽면 ↔ 측벽 8m (창 없는 장벽끼리도 보수적으로 8m)
  return { rule: "창없음", required: noWindowM };
}

/** 인동거리 검토 실행 — 모든 계획주동 쌍의 마주보는 벽면 */
export function runSpacingCheck(project: Project): SpacingResult {
  const {
    spacingRatioWindow: ratioWindow,
    spacingNoWindowM: noWindowM,
    spacingSideM: sideM,
  } = project.analysis.setbackRules;

  const plans = project.buildings
    .filter((b) => b.type === "계획주동")
    .map(mkEntry)
    .filter((p) => p.fp.length >= 3);
  const blockers = new EdgeIndex(edgesOf(plans));
  const candidates = facingCandidates(plans, blockers);

  const checks: SpacingCheck[] = [];
  for (let ai = 0; ai < plans.length; ai++) {
    for (let bi = ai + 1; bi < plans.length; bi++) {
      const A = plans[ai];
      const B = plans[bi];

      // 평면상 겹침(포함 포함) — 이격 0으로 즉시 위반
      if (
        pointInPolygon(A.fp[0].x, A.fp[0].y, B.fp) ||
        pointInPolygon(B.fp[0].x, B.fp[0].y, A.fp)
      ) {
        const height = Math.max(A.height, B.height);
        checks.push({
          aId: A.id,
          aName: A.name,
          bId: B.id,
          bName: B.name,
          distance: 0,
          required: height * ratioWindow,
          rule: "채광",
          height,
          overlapLen: 0,
          pass: false,
          pa: A.fp[0],
          pb: A.fp[0],
        });
        continue;
      }

      // 양방향으로 마주보는 벽면 쌍 수집 (직각방향 확장 겹침이 있는 것만)
      let worst: SpacingCheck | null = null;
      const consider = (
        src: PlanEntry,
        tgt: PlanEntry,
        srcIsA: boolean,
      ) => {
        const si = srcIsA ? ai : bi;
        // 직각 광선이 실제로 닿은 벽면 쌍만 정밀 판정 (943벽 전수 대조는 드래그 중 너무 느리다)
        for (const [cs, i, , j] of candidates.get(ai * 10000 + bi) ?? []) {
          if (cs !== si) continue;
          {
            const f = facingDistance(src, i, tgt, j, blockers);
            if (!f) continue;
            const { rule, required } = ruleFor(
              src,
              i,
              tgt,
              j,
              ratioWindow,
              noWindowM,
              sideM,
            );
            const check: SpacingCheck = {
              aId: A.id,
              aName: A.name,
              bId: B.id,
              bName: B.name,
              distance: f.distance,
              required,
              rule,
              height: Math.max(A.height, B.height),
              overlapLen: f.overlapLen,
              pass: f.distance >= required - 1e-9,
              pa: srcIsA ? f.pSrc : f.pTgt,
              pb: srcIsA ? f.pTgt : f.pSrc,
            };
            // 가장 불리한(여유 = 거리 − 기준 최소) 벽면 쌍을 대표로 채택
            if (
              !worst ||
              check.distance - check.required < worst.distance - worst.required
            ) {
              worst = check;
            }
          }
        }
      };
      consider(A, B, true);
      consider(B, A, false);

      // 마주보는 벽면이 전혀 없으면(대각선 배치 등) 검토 대상 아님
      if (worst) checks.push(worst);
    }
  }
  return {
    ratioWindow,
    noWindowM,
    sideM,
    checks,
    violations: checks.filter((c) => !c.pass).length,
  };
}

// ---------- 시각화 ----------

const PASS_COLOR = 0x9aa0a6; // 적합 — 회색
const FAIL_COLOR = 0xe5484d; // 위반 — 빨강
/** 이격선 표시 높이 (m) */
const LINE_Y = 0.8;

// 매 프레임 재생성되므로 지오메트리·머티리얼은 모듈 공유(디스포즈 금지)
const lineGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
const endGeom = new THREE.SphereGeometry(1, 10, 8);
const passMat = new THREE.MeshBasicMaterial({
  color: PASS_COLOR,
  transparent: true,
  opacity: 0.8,
});
const failMat = new THREE.MeshBasicMaterial({ color: FAIL_COLOR });

/**
 * 마주보는 벽면 쌍의 직각방향 이격선 오버레이 (빨강=위반, 회색=적합).
 * 공유 지오메트리·머티리얼만 쓰므로 그룹 제거 시 dispose 불필요.
 * @param elevate (x,y DXF)→지형 고도(m). 주면 이격선을 지형 표면 위로 올린다
 *   (M7 — 지형 면에 묻히지 않게. 판정 자체는 동일 레벨 기준 그대로).
 */
export function createSpacingOverlay(
  result: SpacingResult,
  elevate?: (x: number, y: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  const yAt = (x: number, y: number) => (elevate ? elevate(x, y) : 0) + LINE_Y;
  for (const c of result.checks) {
    // 기준의 2배 넘게 떨어진 적합 쌍은 그리지 않는다 — 회전된 동의 직각선이 단지 건너편까지
    // 길게 뻗어 화면을 덮는 것을 막는다(판정·개수에는 그대로 포함)
    if (c.pass && c.distance > Math.max(c.required * 2, 1)) continue;
    const mat = c.pass ? passMat : failMat;
    const radius = c.pass ? 0.3 : 0.5;
    const a = new THREE.Vector3(c.pa.x, yAt(c.pa.x, c.pa.y), -c.pa.y); // DXF y+ → three -z
    const b = new THREE.Vector3(c.pb.x, yAt(c.pb.x, c.pb.y), -c.pb.y);
    const len = a.distanceTo(b);

    if (len > 1e-6) {
      const line = new THREE.Mesh(lineGeom, mat);
      line.scale.set(radius, len, radius);
      line.quaternion.setFromUnitVectors(
        up,
        b.clone().sub(a).normalize(),
      );
      line.position.copy(a).add(b).multiplyScalar(0.5);
      group.add(line);
    }
    for (const p of [a, b]) {
      const end = new THREE.Mesh(endGeom, mat);
      end.scale.setScalar(radius * 2.5);
      end.position.copy(p);
      group.add(end);
    }
  }
  return group;
}
