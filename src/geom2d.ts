import type { Point2 } from "./types";

/**
 * M3 사선·이격 검토용 2D 기하 유틸 (DXF 평면, m 단위).
 * 태양·레이캐스팅과 무관한 결정적 계산만 담는다 — sun.ts / insolation.ts 를
 * 참조하지 않는다 (plan.md 2장: 정북사선·채광사선 혼용 금지).
 */

/** 폴리곤 부호 면적 (CCW 양수) */
export function signedArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(x: number, y: number, pts: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i];
    const pj = pts[j];
    if (
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * 원점 o에서 방향 dir(단위벡터 아님 허용)로 쏜 반직선과 선분 ab의 교차 거리.
 * 교차하지 않으면 null. dir이 단위벡터이면 반환값 = 수평거리(m).
 */
export function raySegmentDistance(
  o: Point2,
  dir: Point2,
  a: Point2,
  b: Point2,
): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = cross(dir.x, dir.y, ex, ey);
  if (Math.abs(denom) < 1e-12) return null; // 평행 — 스침은 무시
  const ox = a.x - o.x;
  const oy = a.y - o.y;
  const t = cross(ox, oy, ex, ey) / denom; // 반직선 파라미터
  const s = cross(ox, oy, dir.x, dir.y) / denom; // 선분 파라미터
  if (t < 0 || s < 0 || s > 1) return null;
  return t;
}

/** 반직선과 폴리곤 외곽의 최근접 교차 거리. 교차 없으면 null */
export function rayPolygonDistance(
  o: Point2,
  dir: Point2,
  poly: Point2[],
): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const t = raySegmentDistance(o, dir, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** 점 p에서 선분 ab 위의 최근접 점 */
export function closestPointOnSegment(p: Point2, a: Point2, b: Point2): Point2 {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  if (len2 < 1e-12) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + ex * t, y: a.y + ey * t };
}

export interface ClosestPair {
  distance: number;
  /** A쪽 최근접 점 */
  pa: Point2;
  /** B쪽 최근접 점 */
  pb: Point2;
  /** pa가 속한 polyA 에지 인덱스(i→i+1) — polygonPolygonClosest에서만 채워짐. 포함관계 등 특수 케이스는 -1 */
  ia?: number;
  /** pb가 속한 polyB 에지 인덱스 */
  ib?: number;
}

/** 두 선분 사이 최단거리와 최근접 점 쌍 */
export function segmentSegmentClosest(
  a1: Point2,
  a2: Point2,
  b1: Point2,
  b2: Point2,
): ClosestPair {
  // 선분끼리 교차하면 거리 0
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const denom = cross(d1x, d1y, b2.x - b1.x, b2.y - b1.y);
  if (Math.abs(denom) > 1e-12) {
    const ox = b1.x - a1.x;
    const oy = b1.y - a1.y;
    const t = cross(ox, oy, b2.x - b1.x, b2.y - b1.y) / denom;
    const s = cross(ox, oy, d1x, d1y) / denom;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) {
      const p = { x: a1.x + d1x * t, y: a1.y + d1y * t };
      return { distance: 0, pa: p, pb: p };
    }
  }
  // 미교차 — 끝점→상대 선분 4조합 중 최소
  let best: ClosestPair | null = null;
  const consider = (p: Point2, s1: Point2, s2: Point2, pIsA: boolean) => {
    const q = closestPointOnSegment(p, s1, s2);
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || d < best.distance) {
      best = pIsA ? { distance: d, pa: p, pb: q } : { distance: d, pa: q, pb: p };
    }
  };
  consider(a1, b1, b2, true);
  consider(a2, b1, b2, true);
  consider(b1, a1, a2, false);
  consider(b2, a1, a2, false);
  return best!;
}

/**
 * 두 폴리곤 외곽 사이 최단거리와 최근접 점 쌍.
 * 겹치거나 한쪽이 다른 쪽 안에 있으면 거리 0.
 */
export function polygonPolygonClosest(
  polyA: Point2[],
  polyB: Point2[],
): ClosestPair {
  // 포함 관계 (에지 교차 없이 완전히 안에 있는 경우) — 특정 에지가 아니므로 ia/ib는 -1
  if (pointInPolygon(polyA[0].x, polyA[0].y, polyB)) {
    return { distance: 0, pa: polyA[0], pb: polyA[0], ia: -1, ib: -1 };
  }
  if (pointInPolygon(polyB[0].x, polyB[0].y, polyA)) {
    return { distance: 0, pa: polyB[0], pb: polyB[0], ia: -1, ib: -1 };
  }
  let best: ClosestPair | null = null;
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const c = segmentSegmentClosest(
        a1,
        a2,
        polyB[j],
        polyB[(j + 1) % polyB.length],
      );
      if (!best || c.distance < best.distance) best = { ...c, ia: i, ib: j };
      if (best.distance === 0) return best;
    }
  }
  return best!;
}
