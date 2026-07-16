import type { Point2 } from "./types";

/**
 * 창면(PLAN_WIN/ADJ_WIN) 매칭 유틸 — 채광사선(daylight.ts)·인동거리(spacing.ts) 판정에서
 * "이 벽면에 창이 있는가"를 결정적으로 판단하는 데 쓰인다.
 * mm→m 변환 후 좌표 기준 허용오차이므로 원본 도면 단위와 무관하게 0.1m로 고정.
 */
export const WINDOW_MATCH_TOLERANCE = 0.1;

/**
 * 창선(wa→wb)이 벽면(a→b) **위에 겹쳐 놓여 있는지**.
 * 벽 전체를 덮지 않고 일부 구간만 덮어도 참 — 실무 도면은 창을 벽 일부에만 그리는 일이
 * 흔하고, 법 판정 단위는 어차피 "벽면 1개"이기 때문이다(가/라/마목, 채광사선 모두 벽 단위).
 * 판정 조건:
 *  1. 창선 양 끝점이 벽 **직선에서** tol 이내 (다른 벽·평행한 반대편 벽 배제)
 *  2. 벽 구간과 실제로 겹치는 길이가 tol 초과 (모서리만 스치는 경우 배제)
 */
export function segmentLiesOnEdge(
  a: Point2,
  b: Point2,
  wa: Point2,
  wb: Point2,
  tol: number = WINDOW_MATCH_TOLERANCE,
): boolean {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  if (len2 < 1e-12) return false;
  const len = Math.sqrt(len2);

  // 벽 직선에 투영 — t=0이 a, t=1이 b
  const ta = ((wa.x - a.x) * ex + (wa.y - a.y) * ey) / len2;
  const tb = ((wb.x - a.x) * ex + (wb.y - a.y) * ey) / len2;
  const perpA = Math.hypot(wa.x - (a.x + ex * ta), wa.y - (a.y + ey * ta));
  const perpB = Math.hypot(wb.x - (a.x + ex * tb), wb.y - (a.y + ey * tb));
  if (perpA > tol || perpB > tol) return false;

  // 벽 구간 [0,1]과 창선 구간의 겹침 길이
  const lo = Math.max(0, Math.min(ta, tb));
  const hi = Math.min(1, Math.max(ta, tb));
  return (hi - lo) * len > tol;
}

/** footprint 에지(a→b) 위에 창선이 하나라도 놓여 있으면 창이 있는 벽 */
export function edgeHasWindow(
  a: Point2,
  b: Point2,
  windowSegments: [Point2, Point2][],
  tol: number = WINDOW_MATCH_TOLERANCE,
): boolean {
  return windowSegments.some(([wa, wb]) => segmentLiesOnEdge(a, b, wa, wb, tol));
}
