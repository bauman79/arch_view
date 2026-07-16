import type { Point2 } from "./types";

/**
 * 창면(PLAN_WIN/ADJ_WIN) 매칭 유틸 — 채광사선(daylight.ts)·인동거리(spacing.ts) 판정에서
 * "이 벽면에 창이 있는가"를 결정적으로 판단하는 데 쓰인다.
 * mm→m 변환 후 좌표 기준 허용오차이므로 원본 도면 단위와 무관하게 0.1m로 고정.
 */
export const WINDOW_MATCH_TOLERANCE = 0.1;

function closeEnough(a: Point2, b: Point2, tol: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

/** 두 선분이 (끝점 순서 무관) 허용오차 내에서 같은 위치인지 */
export function segmentsCoincide(
  a1: Point2,
  a2: Point2,
  b1: Point2,
  b2: Point2,
  tol: number = WINDOW_MATCH_TOLERANCE,
): boolean {
  return (
    (closeEnough(a1, b1, tol) && closeEnough(a2, b2, tol)) ||
    (closeEnough(a1, b2, tol) && closeEnough(a2, b1, tol))
  );
}

/** footprint 에지(a→b)가 windowSegments 중 하나와 일치하면 창이 있는 벽 */
export function edgeHasWindow(
  a: Point2,
  b: Point2,
  windowSegments: [Point2, Point2][],
  tol: number = WINDOW_MATCH_TOLERANCE,
): boolean {
  return windowSegments.some(([wa, wb]) => segmentsCoincide(a, b, wa, wb, tol));
}
