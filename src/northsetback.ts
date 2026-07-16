import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { rayPolygonDistance, raySegmentDistance } from "./geom2d";
import { buildingHeight, type Point2, type Project } from "./types";

/**
 * 정북사선 검토 — 건축법 시행령 제86조 제1항 (전용주거·일반주거지역 건축물 높이 제한).
 * ⚠️ 일조 시뮬레이션이 아니라 **정북 방향 인접대지경계선까지 거리에 따른 높이 제한**이다.
 * 현행 기준(2023 개정 반영):
 *   - 높이 10m 이하인 부분: 인접대지경계선으로부터 1.5m 이상 이격
 *   - 높이 10m 초과 부분: 인접대지경계선으로부터 해당 부분 높이의 1/2 이상 이격
 * 거리 D에서의 허용높이로 환산하면:
 *   - D < 1.5m          : 건축 불가(허용높이 0)
 *   - D ≥ 1.5m          : 허용높이 = max(10, D ÷ 0.5) = max(10, 2×D)
 * 기준값(1.5m / 10m / 0.5)은 조례 대응을 위해 SetbackRules에서 설정 가능하다.
 *
 * "건축물 각 부분"이 기준이므로 건물 중심이 아니라 **footprint의 각 꼭짓점·에지 중점**에서
 * 정북 방향(northAngle 보정 반영)으로 광선을 쏴 ADJ_BOUNDARY(없으면 SITE_BOUNDARY 대체)까지
 * 거리를 재고, 그중 최솟값 D(경계선에 가장 가까운 부분)로 판정한다 — 균일 압출 매스에서는
 * 최소 D 지점이 가장 불리한 부분이다.
 *
 * daylight.ts(채광사선)·spacing.ts(인동거리)와 마찬가지로 태양·raycasting 없는 순수 기하
 * 계산이라 드래그·회전 중 실시간 재계산 가능. 검토선은 적합/위반 무관하게 항상 표시한다.
 */

export type NorthBoundarySource = "ADJ_BOUNDARY" | "SITE_BOUNDARY" | null;

export interface NorthSetbackCheck {
  buildingId: string;
  buildingName: string;
  /** 최소 거리가 나온 건물 부분(꼭짓점 또는 에지 중점, DXF 평면 월드 좌표) — 검토선 시작점 */
  origin: Point2;
  /** 경계선과의 교차점. 경계선을 찾지 못하면 null */
  point: Point2 | null;
  /** 어떤 레이어에서 거리를 구했는지 */
  source: NorthBoundarySource;
  /** 정북 방향 수평거리 D (m) — 건물 각 부분 중 최솟값. 경계선이 없으면 null */
  distance: number | null;
  /** 허용높이 (m). distance가 null이면 null(제한 없음으로 간주 — pass) */
  allowedHeight: number | null;
  /** 실제높이 = 층수 × 층고 (m) */
  actualHeight: number;
  pass: boolean;
}

export interface NorthSetbackResult {
  /** 저층부(≤ lowHeightM) 최소 이격 (m) — 법정 1.5 */
  lowM: number;
  /** 저층부 기준 높이 (m) — 법정 10 */
  lowHeightM: number;
  /** 초과 부분 이격 배율 (× 높이) — 법정 0.5 */
  ratio: number;
  checks: NorthSetbackCheck[];
  violations: number;
}

/**
 * 거리 D에서의 허용높이 (건축법 시행령 제86조 제1항 현행 기준).
 * D < lowM이면 0(그 지점엔 어떤 높이도 불가), 아니면 max(lowHeightM, D ÷ ratio).
 */
export function allowedHeightFromDistance(
  d: number,
  lowM: number,
  lowHeightM: number,
  ratio: number,
): number {
  if (d < lowM - 1e-9) return 0;
  return Math.max(lowHeightM, d / ratio);
}

/** OverlayLine을 세그먼트(양 끝점 쌍) 목록으로 펼침 — closed면 마지막→첫점도 포함 */
function overlaySegments(points: Point2[], closed: boolean): [Point2, Point2][] {
  const segs: [Point2, Point2][] = [];
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    segs.push([points[i], points[(i + 1) % n]]);
  }
  return segs;
}

/** footprint의 검토 샘플점: 꼭짓점 + 각 에지 중점 (경계선 꺾임을 놓칠 확률을 줄임) */
function samplePoints(fp: Point2[]): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const b = fp[(i + 1) % fp.length];
    pts.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return pts;
}

/**
 * 정북사선 검토 실행 — 계획주동마다 1회 판정. 결정적 기하 계산이라
 * 드래그·회전·정북각 변경 중 매 프레임 호출해도 무방하다.
 */
export function runNorthSetbackCheck(project: Project): NorthSetbackResult {
  const {
    northSetbackLowM: lowM,
    northSetbackLowHeightM: lowHeightM,
    northSetbackRatio: ratio,
  } = project.analysis.setbackRules;
  const th = THREE.MathUtils.degToRad(project.site.northAngle);
  // 정북 = Y+를 northAngle만큼 반시계 회전 (DXF 평면)
  const north = { x: -Math.sin(th), y: Math.cos(th) };

  const adjSegments: [Point2, Point2][] = [];
  const siteBoundaries: { points: Point2[] }[] = [];
  for (const o of project.siteOverlays) {
    if (o.layer === "ADJ_BOUNDARY") {
      adjSegments.push(...overlaySegments(o.points, o.closed));
    } else if (o.layer === "SITE_BOUNDARY") {
      siteBoundaries.push({ points: o.points });
    }
  }

  const checks: NorthSetbackCheck[] = [];
  for (const b of project.buildings) {
    if (b.type !== "계획주동") continue;
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    const actualHeight = buildingHeight(b);

    // 건물 각 부분(꼭짓점·에지 중점)에서 정북 방향 거리의 최솟값 — 가장 불리한 부분
    let bestDist: number | null = null;
    let bestOrigin: Point2 = fp[0];
    let source: NorthBoundarySource = null;
    for (const p of samplePoints(fp)) {
      let d: number | null = null;
      let src: NorthBoundarySource = null;
      for (const [a, c] of adjSegments) {
        const t = raySegmentDistance(p, north, a, c);
        if (t !== null && (d === null || t < d)) {
          d = t;
          src = "ADJ_BOUNDARY";
        }
      }
      if (d === null) {
        for (const sb of siteBoundaries) {
          const t = rayPolygonDistance(p, north, sb.points);
          if (t !== null && (d === null || t < d)) {
            d = t;
            src = "SITE_BOUNDARY";
          }
        }
      }
      if (d !== null && (bestDist === null || d < bestDist)) {
        bestDist = d;
        bestOrigin = p;
        source = src;
      }
    }

    const allowedHeight =
      bestDist !== null
        ? allowedHeightFromDistance(bestDist, lowM, lowHeightM, ratio)
        : null;
    const point =
      bestDist !== null
        ? { x: bestOrigin.x + north.x * bestDist, y: bestOrigin.y + north.y * bestDist }
        : null;

    checks.push({
      buildingId: b.id,
      buildingName: b.name,
      origin: bestOrigin,
      point,
      source,
      distance: bestDist,
      allowedHeight,
      actualHeight,
      pass: allowedHeight === null ? true : actualHeight <= allowedHeight + 1e-9,
    });
  }

  return {
    lowM,
    lowHeightM,
    ratio,
    checks,
    violations: checks.filter((c) => !c.pass).length,
  };
}

// ---------- 시각화 ----------

const PASS_COLOR = 0x33c161; // 적합 — 초록
const FAIL_COLOR = 0xe5484d; // 위반 — 빨강
const MARKER_Y = 1.8;

// 매 프레임 재생성되므로 지오메트리·머티리얼은 모듈 공유(디스포즈 금지)
const markerGeom = new THREE.SphereGeometry(0.7, 12, 10);
const rayGeom = new THREE.CylinderGeometry(0.15, 0.15, 1, 6);
const passMat = new THREE.MeshBasicMaterial({ color: PASS_COLOR });
const failMat = new THREE.MeshBasicMaterial({ color: FAIL_COLOR });
const passRayMat = new THREE.MeshBasicMaterial({
  color: PASS_COLOR,
  transparent: true,
  opacity: 0.55,
});
const failRayMat = new THREE.MeshBasicMaterial({
  color: FAIL_COLOR,
  transparent: true,
  opacity: 0.8,
});

/**
 * 검토 결과 오버레이 — 건물의 가장 불리한 부분에서 정북 방향 경계선까지의 검토선을
 * 적합(초록)/위반(빨강)으로 **항상** 표시하고, 시작점에 마커를 찍는다.
 * 공유 지오메트리·머티리얼만 쓰므로 그룹 제거 시 dispose 불필요.
 */
export function createNorthSetbackOverlay(result: NorthSetbackResult): THREE.Group {
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  for (const c of result.checks) {
    const marker = new THREE.Mesh(markerGeom, c.pass ? passMat : failMat);
    marker.position.set(c.origin.x, MARKER_Y, -c.origin.y); // DXF y+ → three -z
    group.add(marker);

    if (c.distance !== null && c.distance > 1e-6 && c.point !== null) {
      const dir = new THREE.Vector3(
        c.point.x - c.origin.x,
        0,
        -(c.point.y - c.origin.y),
      ).normalize();
      const ray = new THREE.Mesh(rayGeom, c.pass ? passRayMat : failRayMat);
      ray.scale.set(1, c.distance, 1);
      ray.quaternion.setFromUnitVectors(up, dir);
      ray.position
        .set(c.origin.x, MARKER_Y, -c.origin.y)
        .addScaledVector(dir, c.distance / 2);
      group.add(ray);

      const endMarker = new THREE.Mesh(markerGeom, c.pass ? passMat : failMat);
      endMarker.scale.setScalar(0.6);
      endMarker.position.set(c.point.x, MARKER_Y, -c.point.y);
      group.add(endMarker);
    }
  }
  return group;
}
