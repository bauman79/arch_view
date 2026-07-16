import * as THREE from "three";
import type { EpwData } from "./epw";
import {
  buildAnalysisGrid,
  buildObstructionMeshes,
  disposeObstructionMeshes,
  RAY_EPS,
  RAY_FAR,
  type GridCell,
} from "./insolation";
import { faceLabel, pvColor, yieldToEventLoop } from "./pv";
import { sunPosition } from "./sun";
import type { Building, Project } from "./types";

/**
 * M5 — 모드 B 2단계: TMY 기상데이터 기반 PV 절대평가 (plan.md 2장 모드 B).
 * EPW 8,760시간에 대해 셀별 연간 유효 수광량(kWh/m²)을 계산한다.
 *
 * - 직달: DNI × cosθ (θ = 셀 법선과 태양벡터 사이 각 — 내적으로만 판정),
 *   three-mesh-bvh 레이캐스팅으로 차폐 확인. 고도 > 5° 시각만 레이 발사
 *   (저고도 직달은 미미하고 계산량은 2배 — plan.md M5 성능 요구).
 * - 산란: 등방성 하늘 모델 DHI × (1+cosβ)/2 (β = 면 경사 = 법선과 연직 사이 각).
 *   지붕 = DHI 전량, 수직벽 = DHI의 절반. 하늘 차폐는 무시(plan.md 8장 근사).
 *   ⚠️ 무차폐 수평면 합계 = Σ(DNI·sinα + DHI) ≈ 연간 GHI — 이 등식이
 *   PVWatts 검증(인천 약 1,200~1,400 kWh/m²의 ±20%)의 근거다.
 * - 지면 반사는 범위 밖. 태양 위치는 EPW 관측소 좌표·시간대 기준,
 *   각 시간행의 구간 중앙(hour−0.5)에서 계산 — 즉시 단위벡터 변환(각도 비교 금지).
 */

/** 이 고도(°) 이하는 레이캐스팅 생략 — 직달도 함께 생략 (보수적) */
export const PV_ABS_MIN_ALT_DEG = 5;

export interface PvEnergyCellResult {
  directKwh: number;
  diffuseKwh: number;
  totalKwh: number;
}

export interface PvEnergyFaceSummary {
  face: string;
  cellCount: number;
  areaM2: number;
  /** 면적 가중 평균 (kWh/m²·년) */
  meanKwh: number;
  maxKwh: number;
}

export interface PvEnergyBuildingSummary {
  buildingId: string;
  name: string;
  faces: PvEnergyFaceSummary[];
}

export interface PvEnergyResult {
  /** EPW 지역명 (예: "인천") */
  epwLabel: string;
  station: EpwData["location"];
  /** 레이캐스팅한 시각 수 (고도>5° & DNI>0) */
  rayHourCount: number;
  cells: GridCell[];
  results: PvEnergyCellResult[];
  /** 색상 스케일 기준 최대값 (kWh/m²) */
  maxKwh: number;
  summaries: PvEnergyBuildingSummary[];
}

interface RayHour {
  dir: THREE.Vector3;
  /** 해당 1시간의 직달일사 (Wh/m², 법선면) */
  dniWh: number;
}

/**
 * 시간별 태양벡터 사전 계산. DNI>0인 행만 suncalc 호출 (~4,400행),
 * 그중 고도>5°인 행만 레이캐스팅 대상으로 남긴다 (~3,500행).
 * 연도는 분석 설정 기준일의 연도를 따른다 (TMY의 원본 연도는 짜깁기라 무의미).
 */
function buildRayHours(
  epw: EpwData,
  year: number,
  northAngleDeg: number,
): RayHour[] {
  const { latitude, longitude, timezone } = epw.location;
  const rayHours: RayHour[] = [];
  for (const h of epw.hours) {
    if (h.dni <= 0) continue;
    // 구간 중앙(hour−0.5) 현지시각 → UTC (Date.UTC가 시·분 올림 처리)
    const date = new Date(
      Date.UTC(year, h.month - 1, h.day, -timezone, h.hour * 60 - 30),
    );
    const pos = sunPosition(date, latitude, longitude, northAngleDeg);
    if (!pos.dir || pos.altitudeDeg <= PV_ABS_MIN_ALT_DEG) continue;
    rayHours.push({ dir: pos.dir, dniWh: h.dni });
  }
  return rayHours;
}

/**
 * PV 절대평가 실행. M4와 같은 격자·차폐 매스를 쓰되 시각 수가 ~18배
 * (4일×48 → 연간 ~3,500) — 셀 청크를 작게 잡고 매 청크 이벤트 루프에 양보한다.
 * @param onProgress (처리한 셀 수, 전체 셀 수)
 */
export async function runPvEnergyAnalysis(
  project: Project,
  epw: EpwData,
  epwLabel: string,
  onProgress?: (done: number, total: number) => void,
): Promise<PvEnergyResult> {
  const { site, analysis, buildings } = project;
  const year = parseInt(analysis.date.slice(0, 4), 10);
  const rayHours = buildRayHours(epw, year, site.northAngle);
  /** 연간 수평면 산란 합계 (Wh/m²) — 셀 경사 보정 전 */
  const diffuseWh = epw.annual.dhiKwh * 1000;

  // M6.10: 분석 대상 = 계획주동(analysisTarget) 중 창 없는 벽 + 지붕 (유리면 제외)
  const cells = buildAnalysisGrid(buildings, analysis.gridSize, site.northAngle, true);
  const meshes = buildObstructionMeshes(buildings);

  const raycaster = new THREE.Raycaster();
  raycaster.far = RAY_FAR;
  (raycaster as any).firstHitOnly = true;

  const origin = new THREE.Vector3();
  const results: PvEnergyCellResult[] = new Array(cells.length);
  const CHUNK = 40;

  for (let start = 0; start < cells.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, cells.length);
    for (let i = start; i < end; i++) {
      const cell = cells[i];
      let directWh = 0;
      for (const h of rayHours) {
        const cos = cell.normal.dot(h.dir);
        if (cos <= 1e-4) continue; // 뒷면 — 레이 생략
        origin.copy(cell.center).addScaledVector(cell.normal, RAY_EPS);
        raycaster.set(origin, h.dir);
        if (raycaster.intersectObjects(meshes, false).length > 0) continue;
        directWh += h.dniWh * cos;
      }
      // 등방성 하늘: cosβ = 법선·연직 내적 = normal.y
      const skyView = (1 + cell.normal.y) / 2;
      const diffKwh = (diffuseWh * skyView) / 1000;
      const dirKwh = directWh / 1000;
      results[i] = {
        directKwh: dirKwh,
        diffuseKwh: diffKwh,
        totalKwh: dirKwh + diffKwh,
      };
    }
    onProgress?.(end, cells.length);
    if (end < cells.length) await yieldToEventLoop();
  }

  disposeObstructionMeshes(meshes);

  let maxKwh = 0;
  for (const r of results) maxKwh = Math.max(maxKwh, r.totalKwh);

  return {
    epwLabel,
    station: epw.location,
    rayHourCount: rayHours.length,
    cells,
    results,
    maxKwh,
    summaries: summarize(cells, results, buildings, site.northAngle),
  };
}

// ---------- 집계 ----------

const FACE_ORDER = ["지붕", "남측 벽면", "동측 벽면", "서측 벽면", "북측 벽면"];

function summarize(
  cells: GridCell[],
  results: PvEnergyCellResult[],
  buildings: Building[],
  northAngleDeg: number,
): PvEnergyBuildingSummary[] {
  const nameById = new Map(buildings.map((b) => [b.id, b.name]));
  interface Acc {
    cellCount: number;
    areaM2: number;
    /** Σ(kWh/m² × 면적) — 면적 가중 평균용 */
    kwhArea: number;
    maxKwh: number;
  }
  const byBldg = new Map<string, Map<string, Acc>>();

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const r = results[i];
    let faces = byBldg.get(c.buildingId);
    if (!faces) {
      faces = new Map();
      byBldg.set(c.buildingId, faces);
    }
    const label = faceLabel(c, northAngleDeg);
    let acc = faces.get(label);
    if (!acc) {
      acc = { cellCount: 0, areaM2: 0, kwhArea: 0, maxKwh: 0 };
      faces.set(label, acc);
    }
    const area = c.w * c.h;
    acc.cellCount++;
    acc.areaM2 += area;
    acc.kwhArea += r.totalKwh * area;
    acc.maxKwh = Math.max(acc.maxKwh, r.totalKwh);
  }

  const summaries: PvEnergyBuildingSummary[] = [];
  for (const [buildingId, faces] of byBldg) {
    const list: PvEnergyFaceSummary[] = [];
    for (const face of FACE_ORDER) {
      const acc = faces.get(face);
      if (!acc) continue;
      list.push({
        face,
        cellCount: acc.cellCount,
        areaM2: acc.areaM2,
        meanKwh: acc.kwhArea / acc.areaM2,
        maxKwh: acc.maxKwh,
      });
    }
    summaries.push({
      buildingId,
      name: nameById.get(buildingId) ?? buildingId,
      faces: list,
    });
  }
  return summaries;
}

// ---------- 히트맵 오버레이 ----------

const OVERLAY_OFFSET = 0.08;
const Z_PLUS = new THREE.Vector3(0, 0, 1);

/**
 * 연간 kWh/m² 히트맵 오버레이 (M4와 같은 InstancedMesh 방식).
 * 색상은 절대값 기준: 0 → maxKwh를 파랑→노랑→빨강에 매핑 —
 * 범례의 kWh 수치는 결과 패널 note로 표시한다.
 */
export function createPvEnergyOverlay(
  cells: GridCell[],
  results: PvEnergyCellResult[],
  maxKwh: number,
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
  const color = new THREE.Color();
  const denom = maxKwh > 0 ? maxKwh : 1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    quat.setFromUnitVectors(Z_PLUS, c.normal);
    pos.copy(c.center).addScaledVector(c.normal, OVERLAY_OFFSET);
    scale.set(c.w * 0.92, c.h * 0.92, 1);
    mtx.compose(pos, quat, scale);
    inst.setMatrixAt(i, mtx);
    inst.setColorAt(i, pvColor(results[i].totalKwh / denom, color));
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}
