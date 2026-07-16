import * as THREE from "three";
import {
  buildAnalysisGrid,
  buildObstructionMeshes,
  disposeObstructionMeshes,
  RAY_EPS,
  RAY_FAR,
  type GridCell,
} from "./insolation";
import { yieldToEventLoop } from "./pv";
import { sunSamples, type SunSample } from "./sun";
import type { Building, Project, SunHoursRule } from "./types";

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

export interface SunHoursResult {
  rule: SunHoursRule;
  timeStep: number;
  samples: SunSample[];
  cells: GridCell[];
  results: SunHoursCellResult[];
  summaries: SunHoursBuildingSummary[];
}

export function passesRule(rule: SunHoursRule, continuousH: number, totalH: number): boolean {
  const continuousOk = continuousH >= CONTINUOUS_REQUIRED_H - EPS;
  const totalOk = totalH >= TOTAL_REQUIRED_H - EPS;
  if (rule === "continuous") return continuousOk;
  if (rule === "total") return totalOk;
  return continuousOk || totalOk;
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

  const cells = buildAnalysisGrid(
    buildings,
    analysis.gridSize,
    site.northAngle,
    false,
    (b) => b.type === "인접건물",
  );
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
