import Delaunator from "delaunator";
import * as THREE from "three";
import { pointInPolygon } from "./geom2d";
import type { Point2, Point3 } from "./types";

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

// ---------- TIN(불규칙 삼각망) 생성 · 고도 샘플링 ----------

export interface TerrainModel {
  /** TIN 정점 (m, 씬 좌표계 — recenter 적용 후) */
  points: Point3[];
  /** Delaunay 삼각형 정점 인덱스 — 3개씩 한 삼각형 (points 인덱스) */
  triangles: Uint32Array;
  minZ: number;
  maxZ: number;
}

/** 같은 위치(1cm 격자) 중복 점 제거용 키 — 0-면적 삼각형과 Delaunator 퇴화 방지 */
function xyKey(p: Point3): string {
  return `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
}

/**
 * 등고선 점 집합 → Delaunay 삼각분할 TIN.
 * 점이 3개 미만이거나 전부 한 직선 위(삼각형 0개)면 null — 평지 모드 유지.
 */
export function buildTerrainModel(rawPoints: Point3[]): TerrainModel | null {
  const seen = new Set<string>();
  const points: Point3[] = [];
  for (const p of rawPoints) {
    const k = xyKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    points.push(p);
  }
  if (points.length < 3) return null;
  const del = Delaunator.from(
    points,
    (p) => p.x,
    (p) => p.y,
  );
  if (del.triangles.length === 0) return null;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { points, triangles: del.triangles, minZ, maxZ };
}

/**
 * (x, y)의 지형 보간 고도(m) — 점을 포함하는 삼각형의 무게중심(barycentric) 선형 보간.
 * TIN 외곽(convex hull) 밖이면 null.
 */
export function sampleElevation(
  model: TerrainModel,
  x: number,
  y: number,
): number | null {
  const t = model.triangles;
  const pts = model.points;
  const EPS = -1e-9;
  for (let i = 0; i < t.length; i += 3) {
    const a = pts[t[i]];
    const b = pts[t[i + 1]];
    const c = pts[t[i + 2]];
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-12) continue; // 퇴화 삼각형
    const w0 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d;
    const w1 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 >= EPS && w1 >= EPS && w2 >= EPS) {
      return w0 * a.z + w1 * b.z + w2 * c.z;
    }
  }
  return null;
}

/** TIN 정점 중 (x, y)에서 가장 가까운 점의 고도 — hull 밖 폴백용 */
export function nearestPointElevation(
  model: TerrainModel,
  x: number,
  y: number,
): number {
  let best = 0;
  let bestD = Infinity;
  for (const p of model.points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.z;
    }
  }
  return best;
}

/**
 * 건물 G.L.(m) = 월드 좌표 footprint 꼭짓점들의 지형 고도 평균 — 성절토 평탄화 가정
 * (PLAN.md M7 방침 1). hull 밖 꼭짓점은 최근접 TIN 정점 고도로 폴백해, 대지 가장자리로
 * 드래그해도 고도가 0으로 튀지 않게 한다.
 */
export function terrainElevationForFootprint(
  model: TerrainModel,
  worldPts: Point2[],
): number {
  if (worldPts.length === 0) return 0;
  let sum = 0;
  for (const p of worldPts) {
    sum += sampleElevation(model, p.x, p.y) ?? nearestPointElevation(model, p.x, p.y);
  }
  return sum / worldPts.length;
}

// ---------- Three.js 지형 메시 ----------

/** 지형 면 색 — 대지 채움(0x7A828C)보다 살짝 밝은 회색, 그림자 대비 확보 */
const TERRAIN_COLOR = 0x8b939e;
const TERRAIN_WIRE_COLOR = 0x4a5568;

/**
 * 대지경계 폴리곤 밖 삼각형 제거 — 무게중심이 경계 안에 있는 삼각형만 남긴다.
 * sitePoly가 없으면(대지경계 미로드) 전체 삼각형 유지.
 */
export function clipTriangles(
  model: TerrainModel,
  sitePoly: Point2[] | null,
): number[] {
  const t = model.triangles;
  if (!sitePoly || sitePoly.length < 3) return Array.from(t);
  const pts = model.points;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const a = pts[t[i]];
    const b = pts[t[i + 1]];
    const c = pts[t[i + 2]];
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    if (pointInPolygon(cx, cy, sitePoly)) out.push(t[i], t[i + 1], t[i + 2]);
  }
  return out;
}

/**
 * TIN → Three.js 지형 그룹. 자식 2개:
 *  - "terrain-solid": 회색 면 메시, receiveShadow (건물 그림자가 지형 위에 드리움)
 *  - "terrain-wire": 와이어프레임 (기본 숨김 — UI 토글로 표시)
 * DXF (x, y, z) → three (x, z, -y) 매핑은 buildings.ts와 동일. CCW 삼각형이
 * 이 매핑에서 +Y(상향) 법선이 되므로 인덱스 순서는 그대로 쓴다.
 */
export function createTerrainGroup(
  model: TerrainModel,
  sitePoly: Point2[] | null,
): THREE.Group {
  const indices = clipTriangles(model, sitePoly);
  const positions = new Float32Array(model.points.length * 3);
  model.points.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.z;
    positions[i * 3 + 2] = -p.y;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const solid = new THREE.Mesh(
    geom,
    new THREE.MeshLambertMaterial({
      color: TERRAIN_COLOR,
      side: THREE.DoubleSide,
      // 지면판(y=-0.05)·대지 채움(0.02)과 깊이 근접 시 z-fighting 방지 (buildings.ts 참고)
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  solid.name = "terrain-solid";
  solid.receiveShadow = true;

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: TERRAIN_WIRE_COLOR }),
  );
  wire.name = "terrain-wire";
  wire.position.y = 0.03; // 면 위로 살짝 띄워 겹침 얼룩 방지
  wire.visible = false;

  const group = new THREE.Group();
  group.name = "terrain";
  group.add(solid, wire);
  return group;
}
