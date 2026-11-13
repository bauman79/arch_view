import * as THREE from "three";
import {
  buildAnalysisGrid,
  buildObstructionMeshes,
  disposeObstructionMeshes,
  RAY_EPS,
  RAY_FAR,
  type GridCell,
} from "./insolation";
import { worldFootprint } from "./buildings";
import { pointInPolygon, signedArea } from "./geom2d";
import { yieldToEventLoop } from "./pv";
import { sunSamples, type SunSample } from "./sun";
import type { Building, OverlayLine, Point2, Project, SunHoursRule } from "./types";

/**
 * 일조권(수인한도) 검토 — 대법원 판례 기준 09~15시 연속 2시간 이상 또는 08~16시 총 4시간
 * 이상 직달일사를 받는지 시간대별 레이캐스팅으로 판정한다.
 * ⚠️ 정북사선(northsetback.ts, 건축법 시행령 제86조 제1항의 순수 기하 높이제한)과는
 * 근거·계산방식이 전혀 다른 별개의 검토다 — 혼동 금지(PLAN.md 2장).
 * 검토 대상은 **인접건물(ADJ_BLDG)**의 벽면·지붕 — 계획주동이 인접건물에 드리우는 그림자를
 * 본다(PV M4/M5의 analysisTarget=계획주동과는 반대 방향).
 */

const CONTINUOUS_START = 9 * 60;
const CONTINUOUS_END = 15 * 60;
const TOTAL_START = 8 * 60;
const TOTAL_END = 16 * 60;
const CONTINUOUS_REQUIRED_H = 2;
const TOTAL_REQUIRED_H = 4;
const EPS = 1e-6;

export interface SunHoursCellResult {
  /** 09~15시 구간 내 최장 연속 직달시간 (h) */
  continuousHours: number;
  /** 08~16시 구간 누적 직달시간 (h) */
  totalHours: number;
  pass: boolean;
}

export interface SunHoursFaceSummary {
  passCells: number;
  totalCells: number;
}

export interface SunHoursBuildingSummary {
  buildingId: string;
  name: string;
  wall: SunHoursFaceSummary;
  roof: SunHoursFaceSummary;
}

/** 도로 접면을 무엇으로 찾았는지 — null이면 도로 정보가 없어 전체 벽·지붕으로 판정 */
export type RoadFacingSource = "ROAD_AREA" | "ROAD_CL" | null;

export interface SunHoursResult {
  rule: SunHoursRule;
  timeStep: number;
  /** 동 적합 기준 확보율 (0~1) */
  passRatio: number;
  /** 실제로 도로 접면만 판정했는지 (설정이 켜져 있어도 도로 정보가 없으면 false) */
  roadFacingOnly: boolean;
  roadSource: RoadFacingSource;
  /** 도로 접면이 없어 판정에서 빠진 인접건물 수 */
  excludedBuildings: number;
  samples: SunSample[];
  cells: GridCell[];
  results: SunHoursCellResult[];
  summaries: SunHoursBuildingSummary[];
}

/** 동 단위 판정 — 판정 대상 셀이 없으면 "na"(판정 제외) */
export function judgeBuilding(
  s: SunHoursBuildingSummary,
  passRatio: number,
): "pass" | "fail" | "na" {
  const total = s.wall.totalCells + s.roof.totalCells;
  if (total === 0) return "na";
  const ratio = (s.wall.passCells + s.roof.passCells) / total;
  return ratio >= passRatio - EPS ? "pass" : "fail";
}

// ---------- 도로 접면 판별 ----------

/** 도로 영역(ROAD_AREA)까지 벽에서 바깥으로 살펴보는 거리 (m) — 앞마당·담장 폭 정도 */
const ROAD_AREA_REACH_M = 10;
/** 도로중심선(ROAD_CL)만 있을 때 살펴보는 거리 (m) — 앞마당 + 도로 폭의 절반 */
const ROAD_CL_REACH_M = 25;
const MARCH_STEP_M = 0.5;
const INDEX_CELL_M = 20;

interface FootprintRef {
  pts: Point2[];
  minX: number; minY: number; maxX: number; maxY: number;
}

function bboxOf(pts: Point2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 점이 든 폴리곤을 빠르게 찾는 격자 색인 — 630동 × 벽 × 샘플 × 걸음마다 전수 검사는 느리다 */
class PolygonIndex {
  private cells = new Map<string, FootprintRef[]>();
  constructor(polys: Point2[][]) {
    for (const pts of polys) {
      const r: FootprintRef = { pts, ...bboxOf(pts) };
      for (let cx = Math.floor(r.minX / INDEX_CELL_M); cx <= Math.floor(r.maxX / INDEX_CELL_M); cx++) {
        for (let cy = Math.floor(r.minY / INDEX_CELL_M); cy <= Math.floor(r.maxY / INDEX_CELL_M); cy++) {
          const k = `${cx},${cy}`;
          const list = this.cells.get(k);
          if (list) list.push(r); else this.cells.set(k, [r]);
        }
      }
    }
  }
  contains(x: number, y: number): boolean {
    const list = this.cells.get(`${Math.floor(x / INDEX_CELL_M)},${Math.floor(y / INDEX_CELL_M)}`);
    if (!list) return false;
    for (const r of list) {
      if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) continue;
      if (pointInPolygon(x, y, r.pts)) return true;
    }
    return false;
  }
}

function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o = (p: Point2, q: Point2, r: Point2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/**
 * 인접건물마다 도로에 접한 벽(worldFootprint 변 번호)을 찾는다.
 * 벽의 1/4·1/2·3/4 지점에서 바깥 법선 방향으로 조금씩 나아가며, 다른 건물(자기 자신의 오목부
 * 포함)에 막히기 전에 도로에 닿으면 그 지점은 도로 쪽이다. 지점 과반이 닿으면 도로 접면.
 * - ROAD_AREA(닫힌 도로 영역)가 있으면 그 안에 들어서는지로 판정 (10m 이내)
 * - 없으면 ROAD_CL(도로중심선)을 가로지르는지로 판정 (25m 이내)
 */
export function findRoadFacingWalls(
  buildings: Building[],
  overlays: OverlayLine[],
): { walls: Map<string, Set<number>>; source: RoadFacingSource } {
  const walls = new Map<string, Set<number>>();
  const roadAreas = overlays
    .filter((o) => o.layer === "ROAD_AREA" && o.closed && o.points.length >= 3)
    .map((o) => o.points);
  const roadLines: [Point2, Point2][] = [];
  for (const o of overlays) {
    if (o.layer !== "ROAD_CL") continue;
    const n = o.points.length;
    for (let i = 0; i < (o.closed ? n : n - 1); i++) roadLines.push([o.points[i], o.points[(i + 1) % n]]);
  }
  const source: RoadFacingSource = roadAreas.length > 0 ? "ROAD_AREA" : roadLines.length > 0 ? "ROAD_CL" : null;
  if (!source) return { walls, source };

  const footprints = buildings.map((b) => worldFootprint(b)).filter((fp) => fp.length >= 3);
  const blockers = new PolygonIndex(footprints);
  const roads = new PolygonIndex(roadAreas);
  const reach = source === "ROAD_AREA" ? ROAD_AREA_REACH_M : ROAD_CL_REACH_M;

  for (const b of buildings) {
    if (b.type !== "인접건물") continue;
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    const ws = signedArea(fp) >= 0 ? 1 : -1;
    const set = new Set<number>();
    for (let i = 0; i < fp.length; i++) {
      const p1 = fp[i], p2 = fp[(i + 1) % fp.length];
      const ex = p2.x - p1.x, ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len < 1) continue;
      const nx = (ws * ey) / len, ny = (-ws * ex) / len; // 바깥 법선 (buildAnalysisGrid와 같은 규약)
      const ts = len < 3 ? [0.5] : [0.25, 0.5, 0.75];
      let hits = 0;
      for (const t of ts) {
        const o = { x: p1.x + ex * t, y: p1.y + ey * t };
        let prev = o;
        for (let d = 0.3; d <= reach; d += MARCH_STEP_M) {
          const q = { x: o.x + nx * d, y: o.y + ny * d };
          if (blockers.contains(q.x, q.y)) break; // 옆 건물·자기 오목부에 막힘
          if (source === "ROAD_AREA") {
            if (roads.contains(q.x, q.y)) { hits++; break; }
          } else if (roadLines.some(([a, c]) => segmentsCross(prev, q, a, c))) {
            hits++; break;
          }
          prev = q;
        }
      }
      if (hits * 2 >= ts.length + (ts.length > 1 ? 1 : 0)) set.add(i); // 3지점 중 2곳 이상
    }
    if (set.size > 0) walls.set(b.id, set);
  }
  return { walls, source };
}

export function passesRule(rule: SunHoursRule, continuousH: number, totalH: number): boolean {
  const continuousOk = continuousH >= CONTINUOUS_REQUIRED_H - EPS;
  const totalOk = totalH >= TOTAL_REQUIRED_H - EPS;
  if (rule === "continuous") return continuousOk;
  if (rule === "total") return totalOk;
  return continuousOk || totalOk;
}

/**
 * 한 지점(벽·지붕 위)의 직달 일조시간 — 시설 창문 검토·클릭 측정 공용.
 * @param window 연속 일조를 셀 구간 (분) — 기본 09~15시
 */
export function pointSunHours(
  samples: SunSample[],
  stepMin: number,
  position: THREE.Vector3,
  normal: THREE.Vector3,
  meshes: THREE.Mesh[],
  window: [number, number] = [CONTINUOUS_START, CONTINUOUS_END],
): { continuous: number; total: number } {
  const rc = new THREE.Raycaster();
  rc.far = RAY_FAR;
  (rc as any).firstHitOnly = true;
  const origin = new THREE.Vector3();
  const stepH = stepMin / 60;
  let total = 0, run = 0, best = 0;
  for (const s of samples) {
    let lit = false;
    if (s.dir && normal.dot(s.dir) > 1e-4) {
      origin.copy(position).addScaledVector(normal, RAY_EPS);
      rc.set(origin, s.dir);
      lit = meshes.length === 0 || rc.intersectObjects(meshes, false).length === 0;
    }
    if (lit) total += stepH;
    if (s.minutes >= window[0] && s.minutes < window[1]) {
      if (lit) { run += stepH; best = Math.max(best, run); } else run = 0;
    }
  }
  return { continuous: best, total };
}

/** 일조권 검토와 같은 시각 샘플 (08:00 ~ 16:00-간격) */
export function sunHoursSamples(project: Project): SunSample[] {
  const { site, analysis } = project;
  const step = analysis.sunHours.timeStep;
  return sunSamples(analysis.date, site.latitude, site.longitude, site.northAngle, TOTAL_START, TOTAL_END - step, step);
}

/**
 * 인접건물 대상 격자·레이캐스팅 판정 실행. 계산량이 PV(M4)와 비슷한 규모라 같은
 * 청크 비동기 패턴(yieldToEventLoop)을 재사용한다.
 */
export async function runSunHoursCheck(
  project: Project,
  onProgress?: (done: number, total: number) => void,
): Promise<SunHoursResult> {
  const { site, analysis, buildings } = project;
  const { timeStep, rule } = analysis.sunHours;

  const samples = sunSamples(
    analysis.date,
    site.latitude,
    site.longitude,
    site.northAngle,
    TOTAL_START,
    TOTAL_END - timeStep,
    timeStep,
  );

  const wantRoadOnly = analysis.sunHours.roadFacingOnly ?? true;
  const passRatio = analysis.sunHours.passRatio ?? 0.5;
  const road = wantRoadOnly
    ? findRoadFacingWalls(buildings, project.siteOverlays)
    : { walls: new Map<string, Set<number>>(), source: null as RoadFacingSource };
  // 도로 정보가 없으면 설정이 켜져 있어도 전체 벽·지붕으로 판정한다(결과에 표시)
  const roadOnly = wantRoadOnly && road.source !== null;
  const cells = buildAnalysisGrid(
    buildings,
    analysis.gridSize,
    site.northAngle,
    false,
    (b) => b.type === "인접건물",
    roadOnly
      ? { edgeFilter: (b, i) => road.walls.get(b.id)?.has(i) ?? false, includeRoof: false }
      : {},
  );
  const adjCount = buildings.filter((b) => b.type === "인접건물").length;
  const meshes = buildObstructionMeshes(buildings);

  const raycaster = new THREE.Raycaster();
  raycaster.far = RAY_FAR;
  (raycaster as any).firstHitOnly = true;

  const origin = new THREE.Vector3();
  const stepH = timeStep / 60;
  const results: SunHoursCellResult[] = new Array(cells.length);
  const CHUNK = 250;

  for (let start = 0; start < cells.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, cells.length);
    for (let i = start; i < end; i++) {
      const cell = cells[i];
      let total = 0;
      let run = 0;
      let bestRun = 0;
      for (const s of samples) {
        let lit = false;
        const dir = s.dir;
        if (dir && cell.normal.dot(dir) > 1e-4) {
          origin.copy(cell.center).addScaledVector(cell.normal, RAY_EPS);
          raycaster.set(origin, dir);
          lit = raycaster.intersectObjects(meshes, false).length === 0;
        }
        if (lit) total += stepH;
        if (s.minutes >= CONTINUOUS_START && s.minutes < CONTINUOUS_END) {
          if (lit) {
            run += stepH;
            bestRun = Math.max(bestRun, run);
          } else {
            run = 0;
          }
        }
      }
      results[i] = {
        continuousHours: bestRun,
        totalHours: total,
        pass: passesRule(rule, bestRun, total),
      };
    }
    onProgress?.(end, cells.length);
    if (end < cells.length) await yieldToEventLoop();
  }

  disposeObstructionMeshes(meshes);

  return {
    rule,
    timeStep,
    passRatio,
    roadFacingOnly: roadOnly,
    roadSource: road.source,
    excludedBuildings: roadOnly ? adjCount - road.walls.size : 0,
    samples,
    cells,
    results,
    summaries: summarize(cells, results, buildings),
  };
}

function summarize(
  cells: GridCell[],
  results: SunHoursCellResult[],
  buildings: Building[],
): SunHoursBuildingSummary[] {
  const map = new Map<string, SunHoursBuildingSummary>();
  for (const b of buildings) {
    if (b.type !== "인접건물") continue;
    map.set(b.id, {
      buildingId: b.id,
      name: b.name,
      wall: { passCells: 0, totalCells: 0 },
      roof: { passCells: 0, totalCells: 0 },
    });
  }
  cells.forEach((c, i) => {
    const s = map.get(c.buildingId);
    if (!s) return;
    const bucket = c.surface === "wall" ? s.wall : s.roof;
    bucket.totalCells++;
    if (results[i].pass) bucket.passCells++;
  });
  return [...map.values()];
}

// ---------- 시각화 ----------

const PASS_COLOR = new THREE.Color(0x4c8bf5); // 파랑 — 적합
const FAIL_COLOR = new THREE.Color(0xe5484d); // 빨강 — 위반
const OVERLAY_OFFSET = 0.08;
const Z_PLUS = new THREE.Vector3(0, 0, 1);

/** 셀별 적합/위반을 InstancedMesh 히트맵으로 표시(PV 오버레이와 동일 방식, 이진 색상) */
export function createSunHoursOverlay(
  cells: GridCell[],
  results: SunHoursCellResult[],
): THREE.InstancedMesh {
  const geom = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  const inst = new THREE.InstancedMesh(geom, mat, cells.length);
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    quat.setFromUnitVectors(Z_PLUS, c.normal);
    pos.copy(c.center).addScaledVector(c.normal, OVERLAY_OFFSET);
    scale.set(c.w * 0.92, c.h * 0.92, 1);
    mtx.compose(pos, quat, scale);
    inst.setMatrixAt(i, mtx);
    inst.setColorAt(i, results[i].pass ? PASS_COLOR : FAIL_COLOR);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}
