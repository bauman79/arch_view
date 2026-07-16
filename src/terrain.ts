import type { Point3 } from "./types";

/**
 * M7 지형 — CONTOUR 레이어 등고선 파싱 (PLAN.md "M7 지형 설계 방침").
 *
 * 지형은 배치 시각화(건물 G.L.)·물리 시뮬레이션용이며, 법적 기하 검토
 * (정북사선·채광사선·인동거리)는 지형과 무관하게 동일 레벨을 가정한다 —
 * 이 모듈을 setback 계열 모듈이 import하지 않는 것이 불변식이다.
 */

/**
 * CONTOUR 또는 CONTOUR_<고도 m> — 예: CONTOUR, CONTOUR_10, CONTOUR_25.5, CONTOUR_-3.
 * 접미사 고도는 도면 단위와 무관하게 m 값으로 해석한다(data/CONTOUR_RULES.md).
 */
const CONTOUR_LAYER_RE = /^CONTOUR(?:_(-?\d+(?:\.\d+)?))?$/;

export function isContourLayer(layerUpper: string): boolean {
  return CONTOUR_LAYER_RE.test(layerUpper);
}

/** 레이어명 접미사 고도(m). 접미사 없으면 null — 예: CONTOUR_10.5 → 10.5 */
export function contourSuffixElevation(layerUpper: string): number | null {
  const m = layerUpper.match(CONTOUR_LAYER_RE);
  if (!m || m[1] === undefined) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * CONTOUR 엔티티(LWPOLYLINE/POLYLINE/LINE) → 3D 점 목록(m).
 * 고도 우선순위:
 *  ① 꼭짓점 Z(3D POLYLINE·LINE의 그룹코드 30) 또는 LWPOLYLINE 전체 elevation(그룹코드 38)
 *    — 도면 단위 좌표이므로 unitScale(mm→m 등)을 적용한다.
 *  ② ①이 0이면 레이어명 접미사(CONTOUR_10 → 10m, 단위 변환 없음).
 * dxf.ts의 건물 파싱과 동일하게 extrusion Z<0(AutoCAD MIRROR) 시 x 부호를 반전한다.
 * CONTOUR 레이어가 아니면 null.
 */
export function extractContourPoints(
  entity: any,
  layerUpper: string,
  unitScale: number,
): Point3[] | null {
  if (!isContourLayer(layerUpper)) return null;
  const suffixZ = contourSuffixElevation(layerUpper);
  const extrusionZ: number =
    entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
  const xSign = extrusionZ < 0 ? -1 : 1;
  // LWPOLYLINE은 버텍스에 z가 없고 폴리라인 전체 elevation(38)만 갖는다
  const entityElev: number = typeof entity.elevation === "number" ? entity.elevation : 0;

  const out: Point3[] = [];
  for (const v of entity.vertices ?? []) {
    const rawZ = typeof v.z === "number" && v.z !== 0 ? v.z : entityElev;
    let z = rawZ * unitScale;
    if (z === 0 && suffixZ !== null) z = suffixZ;
    out.push({ x: v.x * xSign * unitScale, y: v.y * unitScale, z });
  }
  return out;
}
