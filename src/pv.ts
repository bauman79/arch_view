import * as THREE from "three";
import {
  buildAnalysisGrid,
  buildObstructionMeshes,
  disposeObstructionMeshes,
  RAY_EPS,
  RAY_FAR,
  type GridCell,
} from "./insolation";
import { sunSamples } from "./sun";
import type { Building, Project } from "./types";

/**
 * M4 — 모드 B 1단계: PV 상대평가 (plan.md 2장 모드 B).
 * 연간 대표일 4일(춘분·하지·추분·동지)의 8~16시 직달일사를 레이캐스팅으로 누적하고,
 * 면 법선과 태양벡터의 내적(cosθ)으로 입사각을 보정해 벽면·지붕을 공정하게 비교한다.
 * 전체 셀 최대값 기준 0~100% 상대 정규화 — 절대 일사량(kWh)은 M5에서.
 * ⚠️ 판정은 전부 벡터 연산(내적·레이) — 방위각 스칼라의 비교·보간 금지.
 */

/** 연간 대표일 (월-일). 연도는 분석 설정 기준일의 연도를 따른다 */
export const PV_DATES_MMDD = ["03-21", "06-21", "09-21", "12-21"] as const;
export const PV_DATE_LABELS = ["춘분", "하지", "추분", "동지"] as const;

/** 분석 시간창 8~16시, 10분 간격 — 각 샘플이 [t, t+10분) 구간을 대표 */
export const PV_START = 8 * 60;
export const PV_END = 16 * 60;
export const PV_STEP_MIN = 10;

/** "상위 셀"로 집계하는 상대효율 기준 (0~1) */
export const PV_TOP_THRESHOLD = 0.7;

/**
 * 청크 사이 이벤트 루프 양보. rAF는 백그라운드 탭에서 멈추고 setTimeout은
 * 숨김 탭에서 분당 1회로 스로틀링되므로 MessageChannel을 쓴다 (스로틀링 없음).
 * Node(vitest) 환경엔 MessageChannel이 전역에 있어 그대로 동작한다.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

export interface PvCellResult {
  /** 4일 합산 직달시간 (h) */
  directHours: number;
  /** 입사각 보정(×cosθ) 유효 직달량 (h) — 상대 점수의 원천 */
  effectiveHours: number;
  /** 대표일별 유효 직달량 (h) — 계절 패턴 검증용 (춘분·하지·추분·동지 순) */
  perDayEffective: number[];
  /** 전체 셀 최대 유효량 대비 상대효율 0~1 */
  score: number;
}

export interface PvFaceSummary {
  /** "지붕" | "남측 벽면" | "북측 벽면" | "동측 벽면" | "서측 벽면" */
  face: string;
  cellCount: number;
  areaM2: number;
  /** score ≥ PV_TOP_THRESHOLD 셀의 면적 합 */
  topAreaM2: number;
  meanScorePct: number;
  maxScorePct: number;
}

export interface PvBuildingSummary {
  buildingId: string;
  name: string;
  faces: PvFaceSummary[];
}

export interface PvResult {
  /** 대표일 4일 "YYYY-MM-DD" */
  dates: string[];
  /** 하루당 시간 샘플 수 */
  samplesPerDay: number;
  cells: GridCell[];
  results: PvCellResult[];
  /** 정규화 기준(전체 셀 최대 유효 직달량, h) */
  maxEffective: number;
  summaries: PvBuildingSummary[];
}

// ---------- 면 방위 라벨 ----------

const FACE_ORDER = ["지붕", "남측 벽면", "동측 벽면", "서측 벽면", "북측 벽면"];

/**
 * 셀의 면 라벨. 벽면 방위는 법선과 방위 벡터의 내적 최대값으로 판별
 * (집계 표시 전용 — 판정 로직에는 쓰이지 않는다).
 */
export function faceLabel(cell: GridCell, northAngleDeg: number): string {
  if (cell.surface === "roof") return "지붕";
  const th = THREE.MathUtils.degToRad(northAngleDeg);
  const sin = Math.sin(th);
  const cos = Math.cos(th);
  // three 좌표(x=동, z=-북)에서 정북 보정된 방위 벡터
  const dirs: Array<[string, number, number]> = [
    ["남측 벽면", sin, cos],
    ["북측 벽면", -sin, -cos],
    ["동측 벽면", cos, -sin],
    ["서측 벽면", -cos, sin],
  ];
  let best = dirs[0][0];
  let bestDot = -Infinity;
  for (const [label, x, z] of dirs) {
    const d = cell.normal.x * x + cell.normal.z * z;
    if (d > bestDot) {
      bestDot = d;
      best = label;
    }
  }
  return best;
}

// ---------- 실행 ----------

/**
 * PV 상대평가 실행. 셀을 청크로 나눠 비동기 처리해 UI 블로킹을 피한다
 * (M2보다 계산량이 큼: 전체 벽면·지붕 × 4일 × 48시각).
 * @param onProgress (처리한 셀 수, 전체 셀 수) — 진행률 표시용
 */
export async function runPvAnalysis(
  project: Project,
  onProgress?: (done: number, total: number) => void,
): Promise<PvResult> {
  const { site, analysis, buildings } = project;
  const year = analysis.date.slice(0, 4);
  const dates = PV_DATES_MMDD.map((md) => `${year}-${md}`);
  // endMin은 포함이므로 마지막 샘플은 15:50 — 8~16시 48샘플 × 10분 = 8h 상한
  const days = dates.map((d) =>
    sunSamples(
      d,
      site.latitude,
      site.longitude,
      site.northAngle,
      PV_START,
      PV_END - PV_STEP_MIN,
      PV_STEP_MIN,
    ),
  );
  // M6.10: 분석 대상 = 계획주동(analysisTarget) 중 창 없는 벽 + 지붕 (유리면 제외)
  const cells = buildAnalysisGrid(
    buildings,
    analysis.gridSize,
    site.northAngle,
    true,
  );
  const meshes = buildObstructionMeshes(buildings);

  const raycaster = new THREE.Raycaster();
  raycaster.far = RAY_FAR;
  (raycaster as any).firstHitOnly = true;

  const origin = new THREE.Vector3();
  const stepH = PV_STEP_MIN / 60;
  const results: PvCellResult[] = new Array(cells.length);
  const CHUNK = 250;

  for (let start = 0; start < cells.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, cells.length);
    for (let i = start; i < end; i++) {
      const cell = cells[i];
      let direct = 0;
      let effective = 0;
      const perDay = [0, 0, 0, 0];
      for (let d = 0; d < days.length; d++) {
        for (const s of days[d]) {
          const dir = s.dir;
          if (!dir) continue; // 태양이 지평선 아래
          const cos = cell.normal.dot(dir);
          if (cos <= 1e-4) continue; // 뒷면 — 직달 없음
          origin.copy(cell.center).addScaledVector(cell.normal, RAY_EPS);
          raycaster.set(origin, dir);
          if (raycaster.intersectObjects(meshes, false).length > 0) continue;
          direct += stepH;
          effective += cos * stepH;
          perDay[d] += cos * stepH;
        }
      }
      results[i] = {
        directHours: direct,
        effectiveHours: effective,
        perDayEffective: perDay,
        score: 0,
      };
    }
    onProgress?.(end, cells.length);
    if (end < cells.length) await yieldToEventLoop();
  }

  disposeObstructionMeshes(meshes);

  let maxEffective = 0;
  for (const r of results) maxEffective = Math.max(maxEffective, r.effectiveHours);
  if (maxEffective > 0) {
    for (const r of results) r.score = r.effectiveHours / maxEffective;
  }

  return {
    dates,
    samplesPerDay: days[0].length,
    cells,
    results,
    maxEffective,
    summaries: summarize(cells, results, buildings, site.northAngle),
  };
}

// ---------- 집계 ----------

function summarize(
  cells: GridCell[],
  results: PvCellResult[],
  buildings: Building[],
  northAngleDeg: number,
): PvBuildingSummary[] {
  const nameById = new Map(buildings.map((b) => [b.id, b.name]));
  interface Acc {
    cellCount: number;
    areaM2: number;
    topAreaM2: number;
    scoreSum: number;
    maxScore: number;
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
      acc = { cellCount: 0, areaM2: 0, topAreaM2: 0, scoreSum: 0, maxScore: 0 };
      faces.set(label, acc);
    }
    const area = c.w * c.h;
    acc.cellCount++;
    acc.areaM2 += area;
    acc.scoreSum += r.score;
    acc.maxScore = Math.max(acc.maxScore, r.score);
    if (r.score >= PV_TOP_THRESHOLD) acc.topAreaM2 += area;
  }

  const summaries: PvBuildingSummary[] = [];
  for (const [buildingId, faces] of byBldg) {
    const list: PvFaceSummary[] = [];
    for (const face of FACE_ORDER) {
      const acc = faces.get(face);
      if (!acc) continue;
      list.push({
        face,
        cellCount: acc.cellCount,
        areaM2: acc.areaM2,
        topAreaM2: acc.topAreaM2,
        meanScorePct: (acc.scoreSum / acc.cellCount) * 100,
        maxScorePct: acc.maxScore * 100,
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

// ---------- CSV ----------

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 셀별 결과 CSV. 좌표·법선은 DXF 평면 좌표(x=동, y=북, z=높이)로 내보낸다
 * (three 좌표 y↑/z−북 → 도면 좌표로 역변환).
 */
export function pvResultToCsv(
  result: PvResult,
  buildings: Building[],
  northAngleDeg: number,
): string {
  const nameById = new Map(buildings.map((b) => [b.id, b.name]));
  const lines = [
    "건물,면,x(m),y(m),z(m),nx,ny,nz,직달시간(h),유효직달(h),상대효율(%)",
  ];
  for (let i = 0; i < result.cells.length; i++) {
    const c = result.cells[i];
    const r = result.results[i];
    const name = csvField(nameById.get(c.buildingId) ?? c.buildingId);
    const face = csvField(faceLabel(c, northAngleDeg));
    lines.push(
      [
        name,
        face,
        c.center.x.toFixed(2),
        (-c.center.z).toFixed(2),
        c.center.y.toFixed(2),
        c.normal.x.toFixed(3),
        (-c.normal.z).toFixed(3),
        c.normal.y.toFixed(3),
        r.directHours.toFixed(2),
        r.effectiveHours.toFixed(3),
        (r.score * 100).toFixed(1),
      ].join(","),
    );
  }
  return lines.join("\n");
}

// ---------- 히트맵 오버레이 ----------

const COLOR_LOW = new THREE.Color(0x2563eb); // 파랑 — 낮음
const COLOR_MID = new THREE.Color(0xfacc15); // 노랑 — 중간
const COLOR_HIGH = new THREE.Color(0xdc2626); // 빨강 — 높음
const OVERLAY_OFFSET = 0.08;
const Z_PLUS = new THREE.Vector3(0, 0, 1);

/** 상대효율 0~1 → 파랑→노랑→빨강 컬러맵 */
export function pvColor(t: number, out = new THREE.Color()): THREE.Color {
  const s = Math.min(1, Math.max(0, t));
  if (s <= 0.5) out.lerpColors(COLOR_LOW, COLOR_MID, s * 2);
  else out.lerpColors(COLOR_MID, COLOR_HIGH, (s - 0.5) * 2);
  return out;
}

/** 셀별 상대효율을 InstancedMesh 히트맵 오버레이로 생성 (M2 오버레이와 동일 방식) */
export function createPvOverlay(
  cells: GridCell[],
  results: PvCellResult[],
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
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    quat.setFromUnitVectors(Z_PLUS, c.normal);
    pos.copy(c.center).addScaledVector(c.normal, OVERLAY_OFFSET);
    scale.set(c.w * 0.92, c.h * 0.92, 1);
    mtx.compose(pos, quat, scale);
    inst.setMatrixAt(i, mtx);
    inst.setColorAt(i, pvColor(results[i].score, color));
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}
