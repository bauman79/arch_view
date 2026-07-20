import * as THREE from "three";
import { worldFootprint } from "./buildings";
import {
  buildAnalysisGrid,
  buildObstructionMeshes,
  disposeObstructionMeshes,
  RAY_EPS,
  RAY_FAR,
} from "./insolation";
import { pointInPolygon } from "./geom2d";
import { yieldToEventLoop } from "./pv";
import { sunSamples, type SunSample } from "./sun";
import type { Point2, Project } from "./types";

/**
 * M9 — 일조시간 지도.
 * 지면(건물 외부 z=0)과 **전체 건물 표면(계획주동 + 인접건물 입면·지붕)**을 격자로
 * 나눠 기준일 08~16시(30분 간격) 직달일조 시간을 히트맵으로 표시한다 — 계획주동이
 * 인접건물의 일조를 얼마나 깎는지 확인하는 것이 핵심 용도. "어디가 몇 시간 해가 드는가"를 보는
 * **시각화 도구**로, 인접건물 적합/위반을 판정하는 일조권 검토(sunhours.ts,
 * M2.1 수인한도)와는 별개다 — 두 모듈을 합치거나 한쪽을 지우지 말 것(PLAN.md 2장).
 * 법적기준 오버레이(showLegal)는 같은 셀에 연속2h(9~15시)/총4h(8~16시) 충족 여부를
 * 이진 색으로 얹어 보여주는 참고 표시일 뿐 M2.1 검토를 대체하지 않는다.
 */

export type SunHoursDate = "동지" | "하지" | "춘분" | "연평균";

/** 분석 격자 간격 (m) — 지면까지 훑으므로 PV(1m)보다 성긴 2m 고정 */
export const SUNMAP_GRID_M = 2;
/** 지면 격자를 건물 bbox 밖으로 확장하는 여유 (m) */
export const SUNMAP_GROUND_MARGIN_M = 15;
/** 분석 시간창 08~16시, 30분 간격 → 17 스텝 × 0.5h */
export const SUNMAP_START_MIN = 8 * 60;
export const SUNMAP_END_MIN = 16 * 60;
export const SUNMAP_STEP_MIN = 30;
const STEP_H = SUNMAP_STEP_MIN / 60;

/** 연속2h 판정 시간창 (9~15시) — 수인한도 판례와 같은 창(참고 표시용) */
const CONT_START_MIN = 9 * 60;
const CONT_END_MIN = 15 * 60;
const CONT_REQUIRED_H = 2;
const TOTAL_REQUIRED_H = 4;
const EPS = 1e-6;

/** 대표 날짜 (월-일). 연평균은 4개 대표일 평균 */
const DATE_MMDD: Record<SunHoursDate, string[]> = {
  동지: ["12-21"],
  하지: ["06-21"],
  춘분: ["03-21"],
  연평균: ["03-21", "06-21", "09-21", "12-21"],
};

export interface SunHoursMapCell {
  /** 셀 중심 (three 월드 좌표) */
  pos: THREE.Vector3;
  /** 바깥쪽 법선 (지면은 +Y) */
  normal: THREE.Vector3;
  /** 오버레이 셀 크기 (m) */
  w: number;
  h: number;
  isGround: boolean;
  /** 직달일조 시간 (h) — 연평균이면 4개 대표일 평균 */
  hours: number;
  /** 법적기준 판정일 기준 9~15시 최장 연속 직달 (h) */
  continuousHours: number;
  /** 법적기준 판정일 기준 8~16시 누적 직달 (h) */
  totalHours: number;
  passContinuous: boolean;
  passTotal: boolean;
}

export interface SunHoursMapResult {
  date: SunHoursDate;
  /** 실제 분석한 날짜들 "YYYY-MM-DD" */
  dates: string[];
  /** 법적기준(연속2h/총4h) 판정에 쓴 날짜 — 연평균이면 동지 */
  legalDate: string;
  cells: SunHoursMapCell[];
  legalCheck: {
    continuous2h: { pass: number; fail: number };
    total4h: { pass: number; fail: number };
  };
  stats: { min: number; max: number; avg: number };
  /** 지면 셀 평균 일조시간 (h) — 지면 셀이 없으면 null */
  groundAvg: number | null;
}

// ---------- 격자 ----------

interface WorkCell {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  w: number;
  h: number;
  isGround: boolean;
}

/** 지면 격자 — 전 건물 bbox+여유를 훑고 footprint 내부는 제외 (z=0, 법선 +Y) */
function buildGroundGrid(project: Project): WorkCell[] {
  const footprints: Point2[][] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of project.buildings) {
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    footprints.push(fp);
    for (const p of fp) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (footprints.length === 0) return [];
  minX -= SUNMAP_GROUND_MARGIN_M;
  minY -= SUNMAP_GROUND_MARGIN_M;
  maxX += SUNMAP_GROUND_MARGIN_M;
  maxY += SUNMAP_GROUND_MARGIN_M;

  const up = new THREE.Vector3(0, 1, 0);
  const cells: WorkCell[] = [];
  for (let x = minX + SUNMAP_GRID_M / 2; x < maxX; x += SUNMAP_GRID_M) {
    for (let y = minY + SUNMAP_GRID_M / 2; y < maxY; y += SUNMAP_GRID_M) {
      let inside = false;
      for (const fp of footprints) {
        if (pointInPolygon(x, y, fp)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      cells.push({
        center: new THREE.Vector3(x, 0, -y),
        normal: up.clone(),
        w: SUNMAP_GRID_M,
        h: SUNMAP_GRID_M,
        isGround: true,
      });
    }
  }
  return cells;
}

// ---------- 실행 ----------

/**
 * 일조시간 지도 분석 — 지면 + 계획주동(analysisTarget) 표면.
 * PV(M4/M5)·일조권 검토와 같은 청크 비동기 패턴(yieldToEventLoop)으로 진행률 표시.
 */
export async function runSunHoursMap(
  project: Project,
  date: SunHoursDate,
  onProgress?: (done: number, total: number) => void,
): Promise<SunHoursMapResult> {
  const { site, analysis, buildings } = project;
  const year = analysis.date.slice(0, 4);
  const dates = DATE_MMDD[date].map((md) => `${year}-${md}`);
  // 수인한도 참고 표시는 판례 기준일(동지)이 기본 — 연평균이어도 동지로 판정
  const legalIdx = dates.length > 1 ? dates.length - 1 : 0;

  const days: SunSample[][] = dates.map((d) =>
    sunSamples(
      d,
      site.latitude,
      site.longitude,
      site.northAngle,
      SUNMAP_START_MIN,
      SUNMAP_END_MIN,
      SUNMAP_STEP_MIN,
    ),
  );

  // 전체 건물 표면(계획주동 + 인접건물 입면·지붕) + 지면 격자 — 계획주동이 인접
  // 건물의 일조를 얼마나 깎는지가 핵심 검증 대상이라 인접건물 표면을 반드시 포함한다
  const buildingCells: WorkCell[] = buildAnalysisGrid(
    buildings,
    SUNMAP_GRID_M,
    site.northAngle,
    false,
    () => true, // analysisTarget 무시 — 인접건물 표면도 격자 생성
  ).map((c) => ({ center: c.center, normal: c.normal, w: c.w, h: c.h, isGround: false }));
  const work = [...buildGroundGrid(project), ...buildingCells];
  const meshes = buildObstructionMeshes(buildings);

  const raycaster = new THREE.Raycaster();
  raycaster.far = RAY_FAR;
  (raycaster as any).firstHitOnly = true;
  const origin = new THREE.Vector3();

  const cells: SunHoursMapCell[] = new Array(work.length);
  const CHUNK = 200;

  for (let start = 0; start < work.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, work.length);
    for (let i = start; i < end; i++) {
      const c = work[i];
      let hoursSum = 0;
      let contH = 0;
      let totH = 0;
      for (let d = 0; d < days.length; d++) {
        let dayTotal = 0;
        let run = 0;
        let bestRun = 0;
        for (const s of days[d]) {
          let lit = false;
          const dir = s.dir;
          if (dir && c.normal.dot(dir) > 1e-4) {
            origin.copy(c.center).addScaledVector(c.normal, RAY_EPS);
            raycaster.set(origin, dir);
            lit = raycaster.intersectObjects(meshes, false).length === 0;
          }
          if (lit) dayTotal += STEP_H;
          if (d === legalIdx && s.minutes >= CONT_START_MIN && s.minutes <= CONT_END_MIN) {
            if (lit) {
              run += STEP_H;
              bestRun = Math.max(bestRun, run);
            } else {
              run = 0;
            }
          }
        }
        hoursSum += dayTotal;
        if (d === legalIdx) {
          contH = bestRun;
          totH = dayTotal;
        }
      }
      cells[i] = {
        pos: c.center,
        normal: c.normal,
        w: c.w,
        h: c.h,
        isGround: c.isGround,
        hours: hoursSum / days.length,
        continuousHours: contH,
        totalHours: totH,
        passContinuous: contH >= CONT_REQUIRED_H - EPS,
        passTotal: totH >= TOTAL_REQUIRED_H - EPS,
      };
    }
    onProgress?.(end, work.length);
    if (end < work.length) await yieldToEventLoop();
  }

  disposeObstructionMeshes(meshes);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let groundSum = 0;
  let groundN = 0;
  let contPass = 0;
  let totPass = 0;
  for (const c of cells) {
    min = Math.min(min, c.hours);
    max = Math.max(max, c.hours);
    sum += c.hours;
    if (c.isGround) {
      groundSum += c.hours;
      groundN++;
    }
    if (c.passContinuous) contPass++;
    if (c.passTotal) totPass++;
  }
  const n = cells.length;

  return {
    date,
    dates,
    legalDate: dates[legalIdx],
    cells,
    legalCheck: {
      continuous2h: { pass: contPass, fail: n - contPass },
      total4h: { pass: totPass, fail: n - totPass },
    },
    stats: n > 0 ? { min, max, avg: sum / n } : { min: 0, max: 0, avg: 0 },
    groundAvg: groundN > 0 ? groundSum / groundN : null,
  };
}

// ---------- 시각화 ----------

/** 일조시간 컬러맵 구간점 (h → 색) — 0h 암청 → 8h 노랑 */
const HOUR_STOPS: [number, number][] = [
  [0, 0x0d1525],
  [1, 0x4f46e5],
  [2, 0x3b82f6],
  [4, 0x06b6d4],
  [6, 0x22c55e],
  [8, 0xeab308],
];

const stopColors = HOUR_STOPS.map(([, hex]) => new THREE.Color(hex));

/** 일조시간(h) → 히트맵 색 (구간 선형보간, 8h 이상은 노랑) */
export function sunHoursColor(hours: number, out = new THREE.Color()): THREE.Color {
  if (hours <= HOUR_STOPS[0][0]) return out.copy(stopColors[0]);
  for (let i = 1; i < HOUR_STOPS.length; i++) {
    if (hours <= HOUR_STOPS[i][0]) {
      const [h0] = HOUR_STOPS[i - 1];
      const [h1] = HOUR_STOPS[i];
      return out.lerpColors(stopColors[i - 1], stopColors[i], (hours - h0) / (h1 - h0));
    }
  }
  return out.copy(stopColors[stopColors.length - 1]);
}

const LEGAL_PASS = new THREE.Color(0x4c8bf5); // 파랑 — 연속2h 또는 총4h 충족
const LEGAL_FAIL = new THREE.Color(0xe5484d); // 빨강 — 둘 다 미달
/** 지면 셀 오프셋 — 뷰어 바닥 그리드와의 z-fighting 회피 */
const GROUND_OFFSET = 0.06;
/** 건물 표면 셀 오프셋 — PV(M4/M5) 오버레이(0.08)와 겹쳐도 위에 그려지게 */
const SURFACE_OFFSET = 0.14;
const Z_PLUS = new THREE.Vector3(0, 0, 1);

/**
 * 일조시간 히트맵 InstancedMesh 그룹.
 * @param showLegal true면 시간 히트맵 대신 법적기준(연속2h 또는 총4h) 충족 여부를
 *   파랑/빨강 이진 색으로 표시 — 참고용이며 M2.1 일조권 검토를 대체하지 않는다.
 */
export function createSunHoursMapOverlay(
  result: SunHoursMapResult,
  showLegal: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "sunhoursmap-overlay";
  const cells = result.cells;
  if (cells.length === 0) return group;

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
  const color = new THREE.Color();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    quat.setFromUnitVectors(Z_PLUS, c.normal);
    pos
      .copy(c.pos)
      .addScaledVector(c.normal, c.isGround ? GROUND_OFFSET : SURFACE_OFFSET);
    scale.set(c.w * 0.92, c.h * 0.92, 1);
    mtx.compose(pos, quat, scale);
    inst.setMatrixAt(i, mtx);
    if (showLegal) {
      inst.setColorAt(i, c.passContinuous || c.passTotal ? LEGAL_PASS : LEGAL_FAIL);
    } else {
      inst.setColorAt(i, sunHoursColor(c.hours, color));
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  group.add(inst);
  return group;
}

export function disposeSunHoursMapOverlay(group: THREE.Group): void {
  group.removeFromParent();
  group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  group.clear();
}
