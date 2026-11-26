import { worldFootprint } from "./buildings";
import type { Building, OverlayLine } from "./types";

/**
 * 분석 반경 — 대상지(SITE_BOUNDARY)와 계획주동을 감싸는 범위에서 radius(m) 안에 드는 주변 건물만 남긴다.
 * 큰 도면(주변 건물 수천 동)에서 일조·그림자·바람 계산을 가볍게 하려는 용도. 계획주동은 항상 포함.
 * radius ≤ 0 이면 전부.
 */
export function nearbyBuildings(buildings: Building[], overlays: OverlayLine[], radius: number): Building[] {
  if (!(radius > 0)) return buildings;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const o of overlays) if (o.layer === "SITE_BOUNDARY") for (const p of o.points) grow(p.x, p.y);
  for (const b of buildings) if (b.type === "계획주동") for (const p of worldFootprint(b)) grow(p.x, p.y);
  if (!Number.isFinite(x0)) return buildings; // 기준 범위 없음
  return buildings.filter((b) => {
    if (b.type === "계획주동") return true;
    const fp = worldFootprint(b);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of fp) {
      if (p.x < bx0) bx0 = p.x;
      if (p.x > bx1) bx1 = p.x;
      if (p.y < by0) by0 = p.y;
      if (p.y > by1) by1 = p.y;
    }
    const dx = Math.max(0, bx0 - x1, x0 - bx1);
    const dy = Math.max(0, by0 - y1, y0 - by1);
    return Math.hypot(dx, dy) <= radius;
  });
}
