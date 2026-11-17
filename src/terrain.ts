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
 * mm(·cm) 도면이라도 고도는 m로 적는 경우가 흔하다 — 도면 단위로 환산해 1m 미만이 되는 값(예: 50 →
 * 0.05m)은 m로 적은 것으로 보고 그대로 쓴다(실제 지반고가 1m 미만인 경우는 드물다).
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
  stats?: { meterZ: number },
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
    if (rawZ !== 0 && unitScale < 1 && Math.abs(z) < 1) {
      z = rawZ; // m로 적은 고도
      if (stats) stats.meterZ++;
    }
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
  const idx = triIndexOf(model);
  const t = model.triangles;
  const pts = model.points;
  const EPS = -1e-9;
  const cx = Math.floor((x - idx.minX) / idx.cell);
  const cy = Math.floor((y - idx.minY) / idx.cell);
  if (cx < 0 || cy < 0 || cx >= idx.nx || cy >= idx.ny) return null;
  const list = idx.cells[cy * idx.nx + cx];
  if (!list) return null;
  for (const i of list) {
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

/** 삼각형 균일 격자 색인 — 고도 조회를 전수 검사(삼각형 수만큼) 대신 셀 하나로 */
interface TriIndex {
  minX: number;
  minY: number;
  cell: number;
  nx: number;
  ny: number;
  cells: (number[] | undefined)[];
  /** 셀별 정점 인덱스 — 최근접 정점 탐색용 */
  pointCells: (number[] | undefined)[];
}

const triIndexCache = new WeakMap<TerrainModel, TriIndex>();

function triIndexOf(model: TerrainModel): TriIndex {
  const hit = triIndexCache.get(model);
  if (hit) return hit;
  const t = model.triangles;
  const pts = model.points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const triCount = t.length / 3;
  // 셀당 삼각형 몇 개 수준이 되도록
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  const cell = Math.max(1, Math.sqrt(area / Math.max(1, triCount)) * 2);
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const cells: (number[] | undefined)[] = new Array(nx * ny);
  for (let i = 0; i < t.length; i += 3) {
    const a = pts[t[i]], b = pts[t[i + 1]], c = pts[t[i + 2]];
    const x0 = Math.floor((Math.min(a.x, b.x, c.x) - minX) / cell);
    const x1 = Math.floor((Math.max(a.x, b.x, c.x) - minX) / cell);
    const y0 = Math.floor((Math.min(a.y, b.y, c.y) - minY) / cell);
    const y1 = Math.floor((Math.max(a.y, b.y, c.y) - minY) / cell);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const k = yy * nx + xx;
        (cells[k] ??= []).push(i);
      }
    }
  }
  const pointCells: (number[] | undefined)[] = new Array(nx * ny);
  pts.forEach((p, i) => {
    const k = Math.floor((p.y - minY) / cell) * nx + Math.floor((p.x - minX) / cell);
    (pointCells[k] ??= []).push(i);
  });
  const idx = { minX, minY, cell, nx, ny, cells, pointCells };
  triIndexCache.set(model, idx);
  return idx;
}

/** TIN 정점 중 (x, y)에서 가장 가까운 점의 고도 — hull 밖 폴백용 (격자 색인으로 주변 셀만 탐색) */
export function nearestPointElevation(
  model: TerrainModel,
  x: number,
  y: number,
): number {
  const idx = triIndexOf(model);
  const pts = model.points;
  // 색인 범위 밖이면 가장 가까운 가장자리 셀부터
  const cx = Math.min(idx.nx - 1, Math.max(0, Math.floor((x - idx.minX) / idx.cell)));
  const cy = Math.min(idx.ny - 1, Math.max(0, Math.floor((y - idx.minY) / idx.cell)));
  let best = 0;
  let bestD = Infinity;
  const maxR = Math.max(idx.nx, idx.ny);
  for (let r = 0; r <= maxR; r++) {
    for (let yy = cy - r; yy <= cy + r; yy++) {
      if (yy < 0 || yy >= idx.ny) continue;
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || xx >= idx.nx) continue;
        if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue; // 고리만
        const list = idx.pointCells[yy * idx.nx + xx];
        if (!list) continue;
        for (const i of list) {
          const p = pts[i];
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p.z;
          }
        }
      }
    }
    // 찾은 점보다 다음 고리가 확실히 멀면 종료
    if (bestD < Infinity) {
      const ringDist = r * idx.cell;
      if (ringDist * ringDist > bestD) break;
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
      // 지면판(y=-0.05)과 깊이 근접 시 z-fighting 방지 — 고정 보정만(기울기 비례 보정은
      // 멀리서 비스듬히 볼 때 지형이 위에 얹은 채움·선을 덮어버린다)
      polygonOffset: true,
      polygonOffsetFactor: 0,
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

  const stepped = createSteppedTerrain(model, sitePoly);
  stepped.visible = false; // 기본은 매끈한 TIN — UI "계단식" 토글로 교대 표시

  const group = new THREE.Group();
  group.name = "terrain";
  group.add(solid, wire, stepped);
  return group;
}

// ---------- 계단식(등고 단 쌓기) 표시 ----------

/** 최저 단도 이 두께만큼은 보이게 하는 바닥 여유 (m) */
const STEP_BASE_PAD = 0.3;

/**
 * 등고선 레벨 목록 — 입력 점의 고유 z (등고선 점이므로 이산 레벨), 오름차순.
 * 부동소수 잡음을 mm 단위 반올림으로 뭉친다.
 */
export function contourLevels(model: TerrainModel): number[] {
  const set = new Set<number>();
  for (const p of model.points) set.add(Math.round(p.z * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

/** 보간 고도 → 그 이하의 최대 등고 레벨 (계단 바닥면 — 절토 없이 단이 딛는 높이) */
export function quantizeToLevel(levels: number[], e: number): number {
  let lv = levels[0];
  for (const l of levels) {
    if (l <= e + 1e-9) lv = l;
    else break;
  }
  return lv;
}

/** 계단 단 경계선(등고선 윤곽) 색 — 첨부 사례처럼 단마다 윤곽이 보이게 */
const STEP_EDGE_COLOR = 0x2d3440;

type V2 = { x: number; y: number; z: number };

/** 삼각형(볼록 다각형)을 z ≥ L (keepAbove) 또는 z < L 반공간으로 자름 — Sutherland–Hodgman */
function clipByLevel(poly: V2[], L: number, keepAbove: boolean): V2[] {
  const out: V2[] = [];
  const inside = (p: V2) => (keepAbove ? p.z >= L : p.z <= L);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const pin = inside(p);
    const qin = inside(q);
    if (pin) out.push(p);
    if (pin !== qin && p.z !== q.z) {
      const t = (L - p.z) / (q.z - p.z);
      if (t > 0 && t < 1) {
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: L });
      }
    }
  }
  return out;
}

function polyArea2(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** 삼각형과 수평면 z = L의 교차 선분 ("위" = z ≥ L 규칙) — 없으면 null */
function levelCut(tri: V2[], L: number): [V2, V2] | null {
  const pts: V2[] = [];
  for (let i = 0; i < 3; i++) {
    const p = tri[i];
    const q = tri[(i + 1) % 3];
    if (p.z >= L !== q.z >= L) {
      const t = (L - p.z) / (q.z - p.z);
      pts.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: L });
    }
  }
  if (pts.length !== 2) return null;
  if (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) < 1e-6) return null;
  return [pts[0], pts[1]];
}

/** 순수 기하 — 테스트용으로 분리. flats: 수평 삼각형(x,y,h)들, walls: 수직 벽 [x1,y1,x2,y2,bottom,top] */
export interface TerraceGeometry {
  flats: number[]; // 9개씩 = 삼각형 (x,y,h)×3
  walls: number[]; // 6개씩
  rims: number[]; // 단 윤곽선 [x1,y1,x2,y2,h] 5개씩
}

/**
 * TIN을 등고 레벨 평면으로 잘라 등고선 곡선을 따르는 계단(테라스) 기하를 만든다.
 * 각 조각은 quantizeToLevel과 같은 규칙(그 이하 최대 레벨)의 높이로 평평하게 놓이고,
 * 레벨 L[j] 경계선을 따라 L[j-1]→L[j] 수직 벽, 대상 영역 외곽에는 base까지 옆면을 세운다.
 */
export function buildTerraceGeometry(
  model: TerrainModel,
  triIndices: number[],
  levels: number[],
  base: number,
): TerraceGeometry {
  const flats: number[] = [];
  const walls: number[] = [];
  const rims: number[] = [];
  const pts = model.points;
  const key = (a: V2, b: V2): string => {
    const ka = `${Math.round(a.x * 1000)},${Math.round(a.y * 1000)}`;
    const kb = `${Math.round(b.x * 1000)},${Math.round(b.y * 1000)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  // 같은 선분이 양쪽 삼각형에서 나오면(능선 위 레벨선 — 양쪽 다 낮음) 벽 없음
  const cutMap = new Map<string, { a: V2; b: V2; lo: number; hi: number; n: number }>();
  const edgeCount = new Map<string, { a: V2; b: V2; n: number }>();

  for (let i = 0; i < triIndices.length; i += 3) {
    const tri: V2[] = [pts[triIndices[i]], pts[triIndices[i + 1]], pts[triIndices[i + 2]]];
    const zMin = Math.min(tri[0].z, tri[1].z, tri[2].z);
    const zMax = Math.max(tri[0].z, tri[1].z, tri[2].z);

    // 외곽 판별용 변 카운트
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      const kk = key(a, b);
      const e = edgeCount.get(kk);
      if (e) e.n++;
      else edgeCount.set(kk, { a, b, n: 1 });
    }

    // 수평 조각 — 레벨 구간 [L[k], L[k+1])
    for (let k = 0; k < levels.length; k++) {
      const lo = levels[k];
      const hi = k + 1 < levels.length ? levels[k + 1] : Infinity;
      if (hi <= zMin && k + 1 < levels.length) continue;
      if (lo > zMax) break;
      let poly: V2[] = tri;
      if (k > 0) poly = clipByLevel(poly, lo, true);
      if (poly.length >= 3 && hi !== Infinity) poly = clipByLevel(poly, hi, false);
      if (poly.length < 3 || Math.abs(polyArea2(poly)) < 1e-8) continue;
      const ccw = polyArea2(poly) > 0;
      for (let t = 1; t + 1 < poly.length; t++) {
        const order = ccw ? [0, t, t + 1] : [0, t + 1, t];
        for (const o of order) flats.push(poly[o].x, poly[o].y, lo);
      }
    }

    // 레벨선 벽 — L[j] (j ≥ 1) 평면과의 교차
    for (let j = 1; j < levels.length; j++) {
      const L = levels[j];
      if (L < zMin || L > zMax) continue;
      const cut = levelCut(tri, L);
      if (!cut) continue;
      const kk = key(cut[0], cut[1]);
      const c = cutMap.get(kk);
      if (c) c.n++;
      else cutMap.set(kk, { a: cut[0], b: cut[1], lo: levels[j - 1], hi: L, n: 1 });
    }
  }

  for (const c of cutMap.values()) {
    if (c.n !== 1) continue;
    walls.push(c.a.x, c.a.y, c.b.x, c.b.y, c.lo, c.hi);
    rims.push(c.a.x, c.a.y, c.b.x, c.b.y, c.hi);
  }

  // 외곽 옆면 — 변을 레벨 교차점에서 나눠 조각마다 base→단 높이
  for (const e of edgeCount.values()) {
    if (e.n !== 1) continue;
    const ts = [0, 1];
    for (const L of levels) {
      if (e.a.z !== e.b.z) {
        const t = (L - e.a.z) / (e.b.z - e.a.z);
        if (t > 1e-9 && t < 1 - 1e-9) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      const h = quantizeToLevel(levels, e.a.z + (e.b.z - e.a.z) * tm);
      const x0 = e.a.x + (e.b.x - e.a.x) * t0;
      const y0 = e.a.y + (e.b.y - e.a.y) * t0;
      const x1 = e.a.x + (e.b.x - e.a.x) * t1;
      const y1 = e.a.y + (e.b.y - e.a.y) * t1;
      walls.push(x0, y0, x1, y1, base, h);
      rims.push(x0, y0, x1, y1, h);
    }
  }
  return { flats, walls, rims };
}

/**
 * 계단식(콘타 단) 지형 — TIN을 등고 레벨 평면으로 잘라, 등고선 곡선을 따라
 * 판이 한 단씩 쌓인 모형 형태로 만든다. 주동 G.L.·오버레이는 quantizeToLevel로
 * 같은 단 높이에 얹힌다.
 */
function createSteppedTerrain(
  model: TerrainModel,
  sitePoly: Point2[] | null,
): THREE.Object3D {
  const levels = contourLevels(model);
  const base = model.minZ - STEP_BASE_PAD;
  const geo = buildTerraceGeometry(model, clipTriangles(model, sitePoly), levels, base);

  const pos: number[] = [];
  const f = geo.flats;
  for (let i = 0; i < f.length; i += 3) pos.push(f[i], f[i + 2], -f[i + 1]);
  const w = geo.walls;
  for (let i = 0; i < w.length; i += 6) {
    const [x1, y1, x2, y2, lo, hi] = [w[i], w[i + 1], w[i + 2], w[i + 3], w[i + 4], w[i + 5]];
    pos.push(x1, lo, -y1, x2, lo, -y2, x2, hi, -y2);
    pos.push(x1, lo, -y1, x2, hi, -y2, x1, hi, -y1);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshLambertMaterial({
      color: TERRAIN_COLOR,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  mesh.receiveShadow = true;

  const linePos: number[] = [];
  const r = geo.rims;
  for (let i = 0; i < r.length; i += 5) {
    linePos.push(r[i], r[i + 4], -r[i + 1], r[i + 2], r[i + 4], -r[i + 3]);
  }
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
  const lines = new THREE.LineSegments(
    lineGeom,
    new THREE.LineBasicMaterial({ color: STEP_EDGE_COLOR }),
  );

  const group = new THREE.Group();
  group.name = "terrain-stepped";
  group.add(mesh, lines);
  return group;
}

// ---------- 표면 얹기용 삼각형 (drape.ts) ----------

/**
 * 지형 표면 삼각형 (x, y, z ×3) — 매끈한 TIN이면 TIN 그대로, 계단식이면 단 판(평평한 조각).
 * 바닥 표시(대지·도로 채움, 분석 히트맵)를 이 삼각형으로 잘라 얹으면 지형과 같은 면에 놓인다.
 */
export function surfaceTriangles(model: TerrainModel, stepped: boolean): Float64Array {
  if (stepped) {
    const levels = contourLevels(model);
    const geo = buildTerraceGeometry(model, Array.from(model.triangles), levels, model.minZ - STEP_BASE_PAD);
    return Float64Array.from(geo.flats);
  }
  const t = model.triangles;
  const out = new Float64Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const p = model.points[t[i]];
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  return out;
}
