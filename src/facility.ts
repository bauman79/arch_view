import * as THREE from "three";
import { worldFootprint, worldTransformer } from "./buildings";
import { pointInPolygon } from "./geom2d";
import { buildObstructionMeshes, disposeObstructionMeshes } from "./insolation";
import { pointSunHours } from "./sunhours";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import {
  FACILITY_USE_LABEL,
  type Building,
  type FacilitySunSettings,
  type FacilityUse,
  type Point2,
  type Project,
} from "./types";

/**
 * 교육·종교시설 창문 일조 검토 — 인접건물 중 유치원·초등학교·교회로 지정한 동의
 * **창문(ADJ_WIN)마다, 교실 층마다** 측정점을 두고 계획 전(계획주동 없음)·후 일조시간을 비교한다.
 *
 * - 유치원·초등학교: 교육환경보호법 시행규칙 별표2 — 동지 08~16시 총 4시간 이상 또는
 *   연속 2시간 이상. 연속 구간은 09~15시가 일반, 일부 교육청은 09~13시로 강화 운영(설정).
 * - 교회: 별도 법 기준이 없어 판례상 수인한도(09~15시 연속 2h 또는 08~16시 총 4h)를 쓴다.
 *
 * 측정점은 창 표시선의 중점, 각 층 바닥 + 측정 높이(기본 1.2m). 판정은 "사업 때문에" 미달이
 * 되는지가 핵심이라 사업 전에 이미 미달인 창은 따로 구분한다.
 * ⚠️ 정북사선(거리 기준)·일반 일조권(sunhours.ts, 도로 접면 격자)과는 별개 검토다.
 */

const TOTAL_START = 8 * 60;
const TOTAL_END = 16 * 60;
const TOTAL_REQUIRED_H = 4;
const CONTINUOUS_REQUIRED_H = 2;
const EPS = 1e-6;

export function defaultFacilitySettings(): FacilitySunSettings {
  return { windowHeightM: 1.2, schoolContinuousWindow: "9-15" };
}

/** 측정점 판정
 * - ok: 사업 후에도 기준 확보
 * - project: 사업 전 확보 → 사업 후 미달 (사업 영향)
 * - worse: 사업 전에도 미달인데 사업으로 일조시간이 더 줄어듦
 * - existing: 사업 전부터 미달, 사업으로 달라지지 않음 (영향 없음)
 */
export type FacilityPointStatus = "ok" | "project" | "worse" | "existing";

export const FACILITY_STATUS_LABEL: Record<FacilityPointStatus, string> = {
  ok: "확보",
  project: "사업으로 미달",
  worse: "기존 미달·추가 감소",
  existing: "기존 미달(영향 없음)",
};

export interface SunHoursPair {
  /** 연속 구간 내 최장 연속 직달시간 (h) */
  continuous: number;
  /** 08~16시 누적 직달시간 (h) */
  total: number;
}

export interface FacilityPoint {
  buildingId: string;
  /** 1부터 */
  floor: number;
  /** 그 동의 몇 번째 창인지 (1부터) */
  window: number;
  /** three 월드 좌표 */
  position: THREE.Vector3;
  normal: THREE.Vector3;
  before: SunHoursPair;
  after: SunHoursPair;
  status: FacilityPointStatus;
}

export interface FacilityBuildingSummary {
  buildingId: string;
  name: string;
  use: FacilityUse;
  /** 검토한 층 범위 */
  floorFrom: number;
  floorTo: number;
  windows: number;
  counts: Record<FacilityPointStatus, number>;
  /** 층별 판정 개수 */
  byFloor: { floor: number; counts: Record<FacilityPointStatus, number> }[];
  /** 사업 영향(사업으로 미달 또는 추가 감소)이 있는 측정점이 하나라도 있으면 true */
  affected: boolean;
}

export interface FacilityResult {
  date: string;
  timeStep: number;
  settings: FacilitySunSettings;
  points: FacilityPoint[];
  summaries: FacilityBuildingSummary[];
  /** 시설로 지정했지만 창(ADJ_WIN)이 없어 검토하지 못한 동 이름 */
  noWindows: string[];
}

/** 용도별 연속 일조 구간 (분) */
export function continuousWindow(use: FacilityUse, s: FacilitySunSettings): [number, number] {
  if (use !== "church" && s.schoolContinuousWindow === "9-13") return [9 * 60, 13 * 60];
  return [9 * 60, 15 * 60];
}

export function facilityRuleLabel(use: FacilityUse, s: FacilitySunSettings): string {
  const [a, b] = continuousWindow(use, s);
  return `연속 2h(${a / 60}~${b / 60}시) 또는 총 4h(8~16시)`;
}

export function passesFacility(h: SunHoursPair): boolean {
  return h.continuous >= CONTINUOUS_REQUIRED_H - EPS || h.total >= TOTAL_REQUIRED_H - EPS;
}

export function classifyPoint(before: SunHoursPair, after: SunHoursPair): FacilityPointStatus {
  if (passesFacility(after)) return "ok";
  if (passesFacility(before)) return "project";
  const decreased =
    after.total < before.total - EPS || after.continuous < before.continuous - EPS;
  return decreased ? "worse" : "existing";
}

/** 검토 층 범위 — classFloors가 없거나 범위를 벗어나면 전 층 안으로 맞춘다 */
export function facilityFloorRange(b: Building): [number, number] {
  const n = Math.max(1, b.floors);
  const from = Math.min(n, Math.max(1, Math.round(b.classFloors?.from ?? 1)));
  const to = Math.min(n, Math.max(from, Math.round(b.classFloors?.to ?? n)));
  return [from, to];
}

/** 창 표시선 → 측정 기준 (도면 평면 월드 좌표의 중점 + 바깥 법선) */
export function windowAnchors(b: Building): { mid: Point2; n: Point2 }[] {
  const toWorld = worldTransformer(b);
  const fp = worldFootprint(b);
  const out: { mid: Point2; n: Point2 }[] = [];
  for (const [a0, b0] of b.windowSegments) {
    const a = toWorld(a0);
    const c = toWorld(b0);
    const ex = c.x - a.x;
    const ey = c.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    let n = { x: ey / len, y: -ex / len };
    // 바깥쪽 판별 — 법선 방향 조금 앞이 건물 안이면 반대쪽이 바깥
    if (pointInPolygon(mid.x + n.x * 0.3, mid.y + n.y * 0.3, fp)) n = { x: -n.x, y: -n.y };
    out.push({ mid, n });
  }
  return out;
}

function emptyCounts(): Record<FacilityPointStatus, number> {
  return { ok: 0, project: 0, worse: 0, existing: 0 };
}

export async function runFacilityCheck(
  project: Project,
  onProgress?: (done: number, total: number) => void,
): Promise<FacilityResult> {
  const { site, analysis, buildings } = project;
  const settings = { ...defaultFacilitySettings(), ...(analysis.facility ?? {}) };
  const timeStep = analysis.sunHours.timeStep;
  const samples = sunSamples(
    analysis.date,
    site.latitude,
    site.longitude,
    site.northAngle,
    TOTAL_START,
    TOTAL_END - timeStep,
    timeStep,
  );

  const facilities = buildings.filter((b) => b.type === "인접건물" && b.use);
  const noWindows: string[] = [];
  const points: FacilityPoint[] = [];
  for (const b of facilities) {
    const anchors = windowAnchors(b);
    if (anchors.length === 0) {
      noWindows.push(b.name);
      continue;
    }
    const [from, to] = facilityFloorRange(b);
    const gl = b.terrainElevation ?? 0;
    for (let f = from; f <= to; f++) {
      const y = gl + (f - 1) * b.floorHeight + Math.min(settings.windowHeightM, b.floorHeight - 0.05);
      anchors.forEach((an, wi) => {
        const zero = { continuous: 0, total: 0 };
        points.push({
          buildingId: b.id,
          floor: f,
          window: wi + 1,
          position: new THREE.Vector3(an.mid.x, y, -an.mid.y),
          normal: new THREE.Vector3(an.n.x, 0, -an.n.y),
          before: zero,
          after: { ...zero },
          status: "existing",
        });
      });
    }
  }

  // 사업 전 = 계획주동을 뺀 차폐, 사업 후 = 전체 차폐
  const beforeMeshes = buildObstructionMeshes(buildings.filter((b) => b.type !== "계획주동"));
  const afterMeshes = buildObstructionMeshes(buildings);
  const useOf = new Map(facilities.map((b) => [b.id, b.use as FacilityUse]));
  const measure = (p: FacilityPoint, meshes: THREE.Mesh[]): SunHoursPair =>
    pointSunHours(samples, timeStep, p.position, p.normal, meshes, continuousWindow(useOf.get(p.buildingId)!, settings));

  const CHUNK = 100;
  try {
    for (let i = 0; i < points.length; i += CHUNK) {
      const end = Math.min(points.length, i + CHUNK);
      for (let k = i; k < end; k++) {
        const p = points[k];
        p.before = measure(p, beforeMeshes);
        p.after = measure(p, afterMeshes);
        p.status = classifyPoint(p.before, p.after);
      }
      onProgress?.(end, points.length);
      if (end < points.length) await yieldToEventLoop();
    }
  } finally {
    disposeObstructionMeshes(beforeMeshes);
    disposeObstructionMeshes(afterMeshes);
  }

  const summaries: FacilityBuildingSummary[] = [];
  for (const b of facilities) {
    const mine = points.filter((p) => p.buildingId === b.id);
    if (mine.length === 0) continue;
    const [from, to] = facilityFloorRange(b);
    const counts = emptyCounts();
    const byFloor: FacilityBuildingSummary["byFloor"] = [];
    for (let f = from; f <= to; f++) byFloor.push({ floor: f, counts: emptyCounts() });
    for (const p of mine) {
      counts[p.status]++;
      byFloor[p.floor - from].counts[p.status]++;
    }
    summaries.push({
      buildingId: b.id,
      name: b.name,
      use: b.use!,
      floorFrom: from,
      floorTo: to,
      windows: windowAnchors(b).length,
      counts,
      byFloor,
      affected: counts.project + counts.worse > 0,
    });
  }

  return { date: analysis.date, timeStep, settings, points, summaries, noWindows };
}

export function facilityUseLabel(u: FacilityUse): string {
  return FACILITY_USE_LABEL[u];
}

// ---------- 시각화 ----------

const STATUS_COLOR: Record<FacilityPointStatus, number> = {
  ok: 0x4c8bf5, // 파랑 — 확보
  project: 0xe5484d, // 빨강 — 사업으로 미달
  worse: 0xf5a524, // 주황 — 기존 미달·추가 감소
  existing: 0x8a8f98, // 회색 — 기존 미달(영향 없음)
};

export function facilityStatusColor(s: FacilityPointStatus): string {
  return "#" + STATUS_COLOR[s].toString(16).padStart(6, "0");
}

/** 측정점마다 창 앞에 작은 판을 세운다 — 판 색 = 판정 */
export function createFacilityOverlay(points: FacilityPoint[]): THREE.Group {
  const g = new THREE.Group();
  g.name = "facility-sun";
  const geom = new THREE.BoxGeometry(1.2, 0.9, 0.12);
  const mats = new Map<FacilityPointStatus, THREE.MeshBasicMaterial>();
  for (const k of Object.keys(STATUS_COLOR) as FacilityPointStatus[]) {
    mats.set(k, new THREE.MeshBasicMaterial({ color: STATUS_COLOR[k] }));
  }
  const zPlus = new THREE.Vector3(0, 0, 1);
  for (const p of points) {
    const m = new THREE.Mesh(geom, mats.get(p.status)!);
    m.quaternion.setFromUnitVectors(zPlus, p.normal);
    m.position.copy(p.position).addScaledVector(p.normal, 0.15);
    m.userData.facilityPoint = true;
    g.add(m);
  }
  return g;
}

export function disposeFacilityOverlay(g: THREE.Group): void {
  const mats = new Set<THREE.Material>();
  const geoms = new Set<THREE.BufferGeometry>();
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geoms.add(o.geometry);
      mats.add(o.material as THREE.Material);
    }
  });
  geoms.forEach((x) => x.dispose());
  mats.forEach((x) => x.dispose());
  g.parent?.remove(g);
}
