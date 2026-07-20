import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { raySegmentDistance, signedArea } from "./geom2d";
import { buildingHeight, type OverlayLayer, type Point2, type Project } from "./types";
import { edgeHasWindow } from "./windows";

/**
 * 채광사선 검토 — 건축법 시행령 제86조, 주택건설기준 등에 관한 규정 제10조.
 * ⚠️ 검토 대상은 **계획주동(PLAN_BLDG)의 창이 있는 벽면**이다 — 인접건물(ADJ_BLDG)은
 * 채광사선 검토 대상이 아니다(예전 구현의 오류였음). 창면에서 벽면 **직각 방향**으로
 * 다음 기준선까지의 수평거리 D를 재고, 그 벽면이 속한 주동의 높이 H와 비교한다:
 *   - 도로(ROAD_CL)·공원(PARK_BOUNDARY) 중심선과 만나면: H/D ≤ daylightRoadParkRatio(완화, 기본 2.0)
 *   - 인접대지경계선(ADJ_BOUNDARY)과 만나면: H/D ≤ daylightRatio(기본 4.0)
 * 여러 기준선이 그 방향에 있으면 **가장 가까운 것**을 기준으로 삼는다(그 기준선의 배율 적용).
 *
 * ⚠️ 정북사선(northsetback.ts)과 완전히 독립된 모듈이다 — 정북사선은 "정북 방향
 * 인접대지경계선까지 거리 → 높이 제한", 채광사선은 "창면 법선 방향 최근접 기준선까지
 * 거리 → H/D 비율" 로 기준선·방향·판정식이 전혀 다르다. 하나로 합치지 않는다.
 *
 * ⚠️ PLAN_WIN 데이터가 없는(windowSegments 비어있는) 건물은 "창 위치를 알 수 없음" —
 * 검토 대상에서 제외한다(과거처럼 남향 벽 전체로 추측하지 않음. 새 기준은 방위와 무관하게
 * 실제 창 위치에 의존하므로 방위 기반 대체 추정이 성립하지 않는다).
 */

const WINDOW_SPACING = 3;
const ORIGIN_EPS = 0.01;

/** 어떤 레이어의 기준선과 만났는지 — 배율 결정에 쓰인다 */
export type DaylightBoundaryType = "ADJ_BOUNDARY" | "ROAD_CL" | "PARK_BOUNDARY";

const DAYLIGHT_LAYERS: DaylightBoundaryType[] = ["ADJ_BOUNDARY", "ROAD_CL", "PARK_BOUNDARY"];

export interface DaylightCheck {
  buildingId: string;
  buildingName: string;
  /** 창 위치 (DXF 평면, 월드 좌표) */
  point: Point2;
  /** 벽 바깥 법선 (단위벡터, DXF 평면) */
  normal: Point2;
  /** 법선 방향 최근접 기준선까지 수평거리 D (m). 기준선이 없으면 null */
  distance: number | null;
  /** 만난 기준선 종류 — 배율 결정 근거 */
  boundaryType: DaylightBoundaryType | null;
  /** 적용된 허용 H/D (기준선 종류에 따라 다름) */
  appliedRatio: number | null;
  /** 벽면이 속한 주동의 높이 H */
  height: number;
  /** H/D. 기준선 없으면 null */
  ratio: number | null;
  pass: boolean;
}

export interface DaylightResult {
  /** 인접대지경계선 기준 허용 H/D */
  boundaryRatio: number;
  /** 도로·공원 중심선 기준 허용 H/D (완화) */
  roadParkRatio: number;
  checks: DaylightCheck[];
  violations: number;
  /** PLAN_WIN 데이터가 없어 검토에서 제외된 계획주동 이름 목록 */
  skippedBuildings: string[];
}

function overlaySegments(points: Point2[], closed: boolean): [Point2, Point2][] {
  const segs: [Point2, Point2][] = [];
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    segs.push([points[i], points[(i + 1) % n]]);
  }
  return segs;
}

/**
 * 채광사선 검토 실행. 결정적 기하 계산 — 드래그·회전 중 매 프레임 호출 가능.
 */
export function runDaylightCheck(project: Project): DaylightResult {
  const { daylightRatio: boundaryRatio, daylightRoadParkRatio: roadParkRatio } =
    project.analysis.setbackRules;

  // 레이어별 기준선 세그먼트 + 적용 배율
  const boundarySegs: { type: DaylightBoundaryType; ratio: number; a: Point2; b: Point2 }[] = [];
  for (const o of project.siteOverlays) {
    const type = DAYLIGHT_LAYERS.find((l) => l === (o.layer as OverlayLayer));
    if (!type) continue;
    const ratio = type === "ADJ_BOUNDARY" ? boundaryRatio : roadParkRatio;
    for (const [a, b] of overlaySegments(o.points, o.closed)) {
      boundarySegs.push({ type, ratio, a, b });
    }
  }

  const checks: DaylightCheck[] = [];
  const skippedBuildings: string[] = [];

  for (const b of project.buildings) {
    if (b.type !== "계획주동") continue;
    if (b.windowSegments.length === 0) {
      skippedBuildings.push(b.name);
      continue; // PLAN_WIN 없음 — 창 위치를 알 수 없어 검토 불가
    }
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    const windingSign = signedArea(fp) >= 0 ? 1 : -1;
    const height = buildingHeight(b);

    for (let i = 0; i < fp.length; i++) {
      const p1 = fp[i];
      const p2 = fp[(i + 1) % fp.length];
      const localP1 = b.footprint[i];
      const localP2 = b.footprint[(i + 1) % b.footprint.length];
      if (!edgeHasWindow(localP1, localP2, b.windowSegments)) continue; // 창 없는 벽 — 검토 제외

      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      // CCW(양의 면적) 폴리곤에서 에지 진행방향의 오른쪽이 바깥
      const normal = {
        x: (windingSign * ey) / len,
        y: (-windingSign * ex) / len,
      };

      const nWin = Math.max(1, Math.round(len / WINDOW_SPACING));
      for (let k = 0; k < nWin; k++) {
        const t = (k + 0.5) / nWin;
        const point = { x: p1.x + ex * t, y: p1.y + ey * t };
        const origin = {
          x: point.x + normal.x * ORIGIN_EPS,
          y: point.y + normal.y * ORIGIN_EPS,
        };
        // 법선 방향 최근접 기준선(레이어 무관 — 가장 가까운 것)
        let best: { d: number; type: DaylightBoundaryType; ratio: number } | null = null;
        for (const seg of boundarySegs) {
          const d = raySegmentDistance(origin, normal, seg.a, seg.b);
          if (d === null) continue;
          if (!best || d < best.d) best = { d, type: seg.type, ratio: seg.ratio };
        }
        const distance = best ? Math.max(best.d + ORIGIN_EPS, 1e-6) : null;
        const ratio = distance !== null ? height / distance : null;
        checks.push({
          buildingId: b.id,
          buildingName: b.name,
          point,
          normal,
          distance,
          boundaryType: best ? best.type : null,
          appliedRatio: best ? best.ratio : null,
          height,
          ratio,
          pass: ratio !== null && best ? ratio <= best.ratio + 1e-9 : true,
        });
      }
    }
  }
  return {
    boundaryRatio,
    roadParkRatio,
    checks,
    violations: checks.filter((c) => !c.pass).length,
    skippedBuildings,
  };
}

// ---------- 시각화 ----------

const PASS_COLOR = 0x33c161; // 적합 — 초록
const FAIL_COLOR = 0xe5484d; // 위반 — 빨강
/** 창 마커 표시 높이 (m) */
const MARKER_Y = 1.8;

// 매 프레임 재생성되므로 지오메트리·머티리얼은 모듈 공유(디스포즈 금지)
const markerGeom = new THREE.SphereGeometry(0.8, 12, 10);
const rayGeom = new THREE.CylinderGeometry(0.3, 0.3, 1, 8);
const passMat = new THREE.MeshBasicMaterial({ color: PASS_COLOR });
const failMat = new THREE.MeshBasicMaterial({ color: FAIL_COLOR });
const failRayMat = new THREE.MeshBasicMaterial({
  color: FAIL_COLOR,
  transparent: true,
  opacity: 0.7,
});

/**
 * 검토 결과 오버레이 — 창 위치 마커(초록/빨강) + 위반 창의 법선 방향 기준선까지 사선.
 * 공유 지오메트리·머티리얼만 쓰므로 그룹 제거 시 dispose 불필요.
 * @param elevate (x,y DXF)→지형 고도(m). 주면 마커·사선을 지형 표면 위로 올린다
 *   (M7 — 지형 면에 묻히지 않게. 판정 자체는 동일 레벨 기준 그대로).
 */
export function createDaylightOverlay(
  result: DaylightResult,
  elevate?: (x: number, y: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  const yAt = (x: number, y: number) => (elevate ? elevate(x, y) : 0) + MARKER_Y;
  for (const c of result.checks) {
    const marker = new THREE.Mesh(markerGeom, c.pass ? passMat : failMat);
    marker.position.set(c.point.x, yAt(c.point.x, c.point.y), -c.point.y); // DXF y+ → three -z
    group.add(marker);

    if (!c.pass && c.distance !== null) {
      // 끝점(기준선 위치)도 각자 지형 고도에 얹어 기울어진 실린더로 연결
      const ex = c.point.x + c.normal.x * c.distance;
      const ey = c.point.y + c.normal.y * c.distance;
      const a = new THREE.Vector3(c.point.x, yAt(c.point.x, c.point.y), -c.point.y);
      const b = new THREE.Vector3(ex, yAt(ex, ey), -ey);
      const len = a.distanceTo(b);
      if (len > 1e-6) {
        const ray = new THREE.Mesh(rayGeom, failRayMat);
        ray.scale.set(1, len, 1);
        ray.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        ray.position.copy(a).add(b).multiplyScalar(0.5);
        group.add(ray);
      }
    }
  }
  return group;
}
