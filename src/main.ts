import { registerSW } from "virtual:pwa-register";
import * as THREE from "three";
import {
  applyRecenterOffset,
  computeRecenterOffset,
  parseDxfBuildings,
  unitSourceLabel,
  type UnitMode,
} from "./dxf";
import { Viewer, VIEW_PRESET_LABEL, type ViewPreset } from "./viewer";
import { pointInPolygon, signedArea } from "./geom2d";
import {
  applyOffset,
  createBuildingObject,
  createOverlayGroup,
  footprintCentroid,
  mirrorBuilding,
  setSelected,
  worldFootprint,
} from "./buildings";
import {
  buildTerrainModel,
  contourLevels,
  createTerrainGroup,
  nearestPointElevation,
  quantizeToLevel,
  sampleElevation,
  terrainElevationForFootprint,
  surfaceTriangles,
  type TerrainModel,
} from "./terrain";
import { createDaylightOverlay, runDaylightCheck, type DaylightResult } from "./daylight";
import {
  createNorthSetbackOverlay,
  runNorthSetbackCheck,
  type NorthSetbackResult,
} from "./northsetback";
// exportXlsx는 xlsx-js-style(대용량)을 끌고 오므로 클릭 시점 동적 import로 로드한다
import {
  buildDxfTextForView,
  DXF_VIEW_LABEL,
  hasExportContent,
} from "./dxfexport";
import {
  deserializeView,
  serializeView,
  VIEW_FORMAT,
  VIEW_VERSION,
  type ViewFileData,
} from "./viewfile";
import { EPW_FILES } from "./epw";
import {
  coverageStats,
  createTemplateBuilding,
  DEFAULT_UNITS_PER_FLOOR,
  MASS_TYPE_LABEL,
  siteUnitTotals,
  templateFootprint,
  totalUnits,
  unitBreakdown,
} from "./massing";
import { createSpacingOverlay, runSpacingCheck, type SpacingResult } from "./spacing";
import { formatMinutes, localDate, sunPosition } from "./sun";
import {
  createFacilityOverlay,
  defaultFacilitySettings,
  FACILITY_STATUS_LABEL,
  facilityStatusColor,
  disposeFacilityOverlay,
  runFacilityCheck,
  type FacilityResult,
} from "./facility";
import {
  createSunHoursOverlay,
  judgeBuilding,
  pointSunHours,
  sunHoursSamples,
  runSunHoursCheck,
  type SunHoursResult,
} from "./sunhours";
import {
  createSunHoursMapOverlay,
  disposeSunHoursMapOverlay,
  HOUR_STOPS,
  runSunHoursMap,
  type SunHoursDate,
  type SunHoursMapResult,
} from "./sunhoursmap";
import {
  computeWindField,
  computeWindRose,
  createWindOverlay,
  disposeWindOverlay,
  traceStreamlines,
  WIND_RATIO_STOPS,
  windDirLabel,
  type WindResult,
  type WindRoseData,
} from "./wind";
import {
  assembleLbmResult,
  buildLbmDomain,
  chooseLbmGridM,
  LBM_MAX_STEPS,
  type LbmResult,
} from "./lbm";
import type {
  LbmDoneMessage,
  LbmProgressMessage,
  LbmRunMessage,
  LbmStopMessage,
} from "./lbm.worker";
import { createLbmHeatmap, RATIO_STOPS, type LbmHeatmap } from "./lbmvis";
import {
  analysisBoard,
  analysisLegends,
  analysisSheets,
  getAnalyses,
  initAnalyses,
  textSprite,
  invalidateAnalyses,
  notifyProjectLoaded,
  registerAnalysis,
  type AnalysisContext,
  type BoardEntry,
  type BoardItem,
} from "./analyses";
import { renderResultBoard } from "./resultboard";
import { buildReportHtml, type ReportFigure } from "./report";
import { makeSurface, type DrapeSurface } from "./drape";
import { diagnoseDxfText, diagnosisHtml } from "./dxfdiag";
import { findMaxFloors, planTypeOf, violations, type MaxFloorResult } from "./maxfloors";
import { defaultTentOptions, planTentLegal, unitsPerFloorOf, type TentOptions, type TentResult } from "./tentplan";
import { yieldToEventLoop } from "./pv";
import { createUnitSunModule } from "./unitsun";
import type { WindDoneMessage, WindRunMessage } from "./wind.worker";
import { createShadowPlanModule } from "./shadowplan";
import { createShadeWalkModule } from "./shadewalk";
import { createThermalModule } from "./thermal";
import { createNoiseModule } from "./noise";
import { createSkyViewModule } from "./skyview";
import { createPrivacyModule } from "./privacy";
import { createSkylineModule } from "./skyline";
import {
  drawLegendsOnCanvas,
  gradientFromStops,
  renderLegendPanel,
  type LegendItem,
} from "./legend";
import { buildObstructionMeshes, disposeObstructionMeshes } from "./insolation";
import {
  buildingHeight,
  defaultProject,
  FACILITY_USE_LABEL,
  mirrorLabel,
  seoulSetbackRules,
  statutorySetbackRules,
  type Building,
  type Canopy,
  type Tree,
  type MassType,
  type OverlayLine,
  type Point2,
  type Project,
  type SetbackRules,
  type SunHoursRule,
} from "./types";
import {
  emptyBuildingStatus,
  refreshMirrorInfo,
  refreshOffsetInfo,
  refreshUpfInput,
  refreshStatusDots,
  renderBuildingList,
  renderLibraryList,
  renderSetbackSummary,
  renderSiteTotals,
  renderSunHoursMapSummary,
  renderSunHoursSummary,
  renderFacilitySummary,
  renderWindSummary,
  renderLbmSummary,
  renderSchemeList,
  renderCompareTable,
  setStatus,
  type BuildingStatus,
  type UiCallbacks,
} from "./ui";
import { initShell, notifyRightPanel } from "./shell";
import { isDrag } from "./pointer";
import {
  canPickDesktop,
  openFromDesktop,
  saveToDesktop,
  shareOrDownload,
  shareOrDownloadText,
} from "./share";
import {
  deleteScheme,
  formatSavedAt,
  listSchemes,
  saveScheme,
  type CheckTally,
  type SchemeMetrics,
} from "./schemes";

// PWA 서비스워커 등록 (빌드에서만 활성 — dev에서는 no-op)
registerSW({ immediate: true });

// 반응형 셸(드로어·툴바 메뉴·경고 모달) 배선 — 3D/분석 로직과 독립
initShell();

const project: Project = defaultProject();
const viewer = new Viewer(document.getElementById("viewport")!);
const groups = new Map<string, THREE.Group>();
let selectedId: string | null = null;
let lastNorthSetback: NorthSetbackResult | null = null;
let lastSunHours: SunHoursResult | null = null;
let lastFacility: FacilityResult | null = null;
/** 계획주동 고정 — DXF를 불러올 때 고른다. 고정이면 드래그·회전·반전을 막고 목록을 접는다 */
let planLocked = false;
let facilityRunning = false;
let facilityGroup: THREE.Group | null = null;
let sunHoursRunning = false;
let lastWind: WindResult | null = null;
let lastLbm: LbmResult | null = null;
let lastSunHoursMap: SunHoursMapResult | null = null;
let sunHoursMapRunning = false;
/** M3 상태 도트 계산용 — updateSetbackChecks()에서 채워짐 (renderSetbackSummary와 별개로 보관) */
let lastDaylight: DaylightResult | null = null;
let lastSpacing: SpacingResult | null = null;

// ---------- 건물 라이브러리 (DXF PLAN_BLDG 템플릿) ----------
/** "장면에 추가" 체크박스에서 현재 선택된 라이브러리 건물 id */
const libraryCheckedIds = new Set<string>();
/** 장면 인스턴스 id → 복제/추가 출처 라이브러리 id (같은 템플릿 재추가 시 배치 stagger용) */
const cloneOrigin = new Map<string, string>();
let sceneSeq = 0;

// ---------- M7 지형 (TIN) ----------

/** 현재 로드된 지형 TIN — null이면 평지 모드 (기존 동작 그대로) */
let terrainModel: TerrainModel | null = null;
/** 등고 레벨 목록 (오름차순) — 계단식 G.L. 스냅용, rebuildTerrain에서 채움 */
let terrainLevels: number[] | null = null;
let terrainGroup: THREE.Group | null = null;
let terrainVisible = true;
let terrainWireframe = false;
let terrainStepped = false;

/**
 * project.terrainPoints로 TIN·지형 메시를 다시 만든다 — DXF 로드/병합·.view 복원 후 호출.
 * 등고선이 없거나 퇴화(일직선)면 지형 없음 = 평지 모드.
 */
function rebuildTerrain(): void {
  if (terrainGroup) {
    viewer.terrainRoot.remove(terrainGroup);
    disposeGroup(terrainGroup);
    terrainGroup = null;
  }
  terrainModel = buildTerrainModel(project.terrainPoints);
  terrainLevels = terrainModel ? contourLevels(terrainModel) : null;
  if (terrainModel) {
    // 대상지로 자르지 않고 등고선이 덮는 범위 전체를 바닥으로 깐다 —
    // 주변 건물도 지형 위에 앉아야 하고, 대상지 밖 경사가 보여야 배치를 판단할 수 있다
    terrainGroup = createTerrainGroup(terrainModel, null);
    applyTerrainVisibility();
    viewer.terrainRoot.add(terrainGroup);
  }
  terrainSummary.textContent = terrainModel
    ? `등고선 점 ${terrainModel.points.length}개 · 삼각형 ${terrainModel.triangles.length / 3}개 · ` +
      `고도 범위 ${terrainModel.minZ.toFixed(1)}m ~ ${terrainModel.maxZ.toFixed(1)}m`
    : "지형 없음 — CONTOUR 레이어가 있는 DXF를 불러오면 표시됩니다.";
}

/**
 * 지형 표시·와이어프레임·계단식 토글 상태를 메시에 반영 + 대지 회색 채움과의 교대 표시.
 * - 계단식: 매끈한 TIN(면·와이어) 대신 등고 단 기둥을 표시
 * - 와이어프레임: 삼각망을 켜고 면을 반투명으로 — 경사면 너머의 검토선·건물이 비쳐 보인다
 */
function applyTerrainVisibility(): void {
  if (terrainGroup) {
    terrainGroup.visible = terrainVisible;
    const solid = terrainGroup.getObjectByName("terrain-solid") as THREE.Mesh | undefined;
    const wire = terrainGroup.getObjectByName("terrain-wire");
    const stepped = terrainGroup.getObjectByName("terrain-stepped");
    if (solid) {
      solid.visible = !terrainStepped;
      const mat = solid.material as THREE.MeshLambertMaterial;
      mat.transparent = terrainWireframe;
      mat.opacity = terrainWireframe ? 0.35 : 1;
      mat.depthWrite = !terrainWireframe; // 반투명일 때 뒤 물체가 깊이에 막히지 않게
      mat.needsUpdate = true;
    }
    if (wire) wire.visible = terrainWireframe && !terrainStepped;
    if (stepped) stepped.visible = terrainStepped;
  }
  // 지형 메시가 보이는 동안 기존 평지용 회색 SITE_BOUNDARY 채움은 숨긴다 (겹침 방지)
  const hideFill = terrainModel !== null && terrainVisible;
  viewer.overlaysRoot.traverse((o) => {
    if (o.name === "site-fill") o.visible = !hideFill;
  });
}

/**
 * 지형 고도 샘플러 — 지형 없으면 null. 검토선·히트맵·유선을 지형 표면 위에 얹는
 * 표시 전용 공용 헬퍼 (법적 판정·시뮬레이션 계산에는 쓰지 않는다).
 */
/** 지형 표면 삼각형 (바닥 표시를 지형에 정확히 얹는 용도) — 지형·계단식 상태별 캐시 */
let drapeCache: { model: TerrainModel; stepped: boolean; s: DrapeSurface } | null = null;
function drapeSurface(): DrapeSurface | undefined {
  const tm = terrainModel;
  if (!tm) return undefined;
  if (!drapeCache || drapeCache.model !== tm || drapeCache.stepped !== terrainStepped) {
    drapeCache = { model: tm, stepped: terrainStepped, s: makeSurface(surfaceTriangles(tm, terrainStepped)) };
  }
  return drapeCache.s;
}

function terrainSampler(): ((x: number, y: number) => number) | undefined {
  const tm = terrainModel;
  if (!tm) return undefined;
  const smooth = (x: number, y: number) => sampleElevation(tm, x, y) ?? nearestPointElevation(tm, x, y);
  // 계단식 표시 중에는 선·채움도 단 높이에 얹는다 — 매끈한 면 높이에 두면 단을 덮어 계단이 안 보인다
  const levels = terrainLevels;
  if (terrainStepped && levels) return (x, y) => quantizeToLevel(levels, smooth(x, y));
  return smooth;
}

/**
 * 건물 G.L.(terrainElevation) 재계산 — offset 반영된 월드 footprint 꼭짓점 고도 평균.
 * 계단식 표시 중엔 그 평균을 등고 단 레벨로 내림 스냅해 주동이 단 위에 앉는다
 * (계획 G.L. — 계단식 성절토 가정). 지형이 없으면 0.
 * 렌더 위치(applyOffset)의 y로만 쓰이고 법적 검토에는 미반영(M7 방침).
 */
function refreshTerrainElevation(b: Building): void {
  if (!terrainModel) {
    b.terrainElevation = 0;
    return;
  }
  const e = terrainElevationForFootprint(terrainModel, worldFootprint(b));
  b.terrainElevation =
    terrainStepped && terrainLevels ? quantizeToLevel(terrainLevels, e) : e;
}

const terrainVisibleInput = document.getElementById("terrain-visible") as HTMLInputElement;
const terrainWireInput = document.getElementById("terrain-wireframe") as HTMLInputElement;
const terrainSummary = document.getElementById("terrain-summary")!;
terrainSummary.textContent = "지형 없음 — CONTOUR 레이어가 있는 DXF를 불러오면 표시됩니다.";

terrainVisibleInput.addEventListener("change", () => {
  terrainVisible = terrainVisibleInput.checked;
  rebuildOverlays(); // 지형 표시 여부에 따라 선을 지형 위/평지로 다시 얹는다 (applyTerrainVisibility 포함)
});

terrainWireInput.addEventListener("change", () => {
  terrainWireframe = terrainWireInput.checked;
  applyTerrainVisibility();
});

const terrainSteppedInput = document.getElementById(
  "terrain-stepped",
) as HTMLInputElement;
terrainSteppedInput.addEventListener("change", () => {
  terrainStepped = terrainSteppedInput.checked;
  applyTerrainVisibility();
  // 주동 G.L.을 표시 모드에 맞춰 재계산 — 계단식이면 단 레벨 스냅, 끄면 TIN 보간 복귀
  for (const b of project.buildings) {
    refreshTerrainElevation(b);
    const g = groups.get(b.id);
    if (g) applyOffset(g, b);
  }
  // 도로·필지·대상지 채움과 검토선도 단 높이로 다시 얹는다
  rebuildOverlays();
  updateSetbackChecks();
  if (terrainModel) {
    setStatus(
      terrainStepped
        ? "계단식 표시 켬 — 주동 지반고(G.L.)를 등고 단 레벨로 스냅했습니다 (법적 검토는 동일 레벨 기준 그대로)"
        : "계단식 표시 끔 — 주동 지반고(G.L.)를 TIN 보간 고도로 되돌렸습니다",
    );
  }
});

// ---------- 건물 씬 구성 ----------

function rebuildAll(): void {
  for (const g of groups.values()) disposeGroup(g);
  viewer.buildingsRoot.clear();
  groups.clear();
  for (const b of project.buildings) {
    refreshTerrainElevation(b);
    const g = createBuildingObject(b);
    groups.set(b.id, g);
    viewer.buildingsRoot.add(g);
    addLabel(g, b);
  }
}

// ---------- 동 라벨 ----------
let labelsOn = false;

/** "계획주동_A_1" → "A-1" */
function shortName(b: Building): string {
  const m = b.name.match(/_([A-Za-z0-9]+)_(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : b.name.replace(/^계획주동_?/, "");
}

function addLabel(g: THREE.Group, b: Building): void {
  if (!labelsOn || b.type !== "계획주동") return;
  const sp = textSprite(`${shortName(b)} · ${b.floors}F`, "#ffffff", 5, "rgba(30,41,59,0.85)");
  sp.name = "label";
  sp.layers.set(1); // 모형 스타일 AO 계산에서 빼기
  sp.position.set(0, buildingHeight(b) + 5, 0);
  g.add(sp);
}

function refreshLabels(): void {
  for (const b of project.buildings) {
    const g = groups.get(b.id);
    if (!g) continue;
    const old = g.getObjectByName("label") as THREE.Sprite | undefined;
    if (old) {
      g.remove(old);
      old.material.map?.dispose();
      old.material.dispose();
    }
    addLabel(g, b);
  }
}

function rebuildOne(b: Building): void {
  const old = groups.get(b.id);
  if (old) {
    viewer.buildingsRoot.remove(old);
    disposeGroup(old);
  }
  refreshTerrainElevation(b);
  const g = createBuildingObject(b);
  groups.set(b.id, g);
  viewer.buildingsRoot.add(g);
  addLabel(g, b);
  if (b.id === selectedId) setSelected(g, true);
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}

// ---------- 선택 / UI 연동 ----------

function selectBuilding(id: string | null): void {
  if (selectedId && groups.has(selectedId)) {
    setSelected(groups.get(selectedId)!, false);
  }
  selectedId = id;
  if (id && groups.has(id)) setSelected(groups.get(id)!, true);
  refreshList();
  updateRotationHandle();
  // 드로어 모드에서 우측 상세 패널이 접혀 있으면 툴바 "결과" 버튼에 갱신 표시
  if (id) notifyRightPanel();
}

/**
 * 건물별 법적 검토 상태 도트 계산 — lastNorthSetback(정북사선)·lastDaylight/lastSpacing(M3, 토글이
 * 켜져 있을 때만 갱신됨)·lastSunHours(일조권, 실행 버튼을 눌러야 갱신됨)를 조합한다.
 * 정북사선·채광사선·인동거리는 계획주동만, 일조권은 인접건물만 해당하므로
 * 나머지는 "na"(회색)로 남는다.
 */
function computeStatusMap(): Map<string, BuildingStatus> {
  const map = new Map<string, BuildingStatus>();
  for (const b of project.buildings) map.set(b.id, emptyBuildingStatus());

  if (lastNorthSetback) {
    for (const c of lastNorthSetback.checks) {
      const cur = map.get(c.buildingId);
      if (cur) cur.m2 = c.pass ? "pass" : "fail";
    }
  }
  if (lastSunHours) {
    for (const s of lastSunHours.summaries) {
      const cur = map.get(s.buildingId);
      if (!cur) continue;
      cur.sh = judgeBuilding(s, lastSunHours.passRatio);
    }
  }
  if (lastFacility) {
    for (const s of lastFacility.summaries) {
      const cur = map.get(s.buildingId);
      if (cur) cur.fac = s.affected ? "fail" : "pass";
    }
  }
  if (lastDaylight) {
    const allPass = new Map<string, boolean>();
    for (const c of lastDaylight.checks) {
      allPass.set(c.buildingId, (allPass.get(c.buildingId) ?? true) && c.pass);
    }
    for (const [id, pass] of allPass) {
      const cur = map.get(id);
      if (cur) cur.m3d = pass ? "pass" : "fail";
    }
  }
  if (lastSpacing) {
    const allPass = new Map<string, boolean>();
    for (const c of lastSpacing.checks) {
      for (const id of [c.aId, c.bId]) {
        allPass.set(id, (allPass.get(id) ?? true) && c.pass);
      }
    }
    for (const [id, pass] of allPass) {
      const cur = map.get(id);
      if (cur) cur.m3s = pass ? "pass" : "fail";
    }
  }
  return map;
}

/**
 * 평형별 층당세대수(unitMix.countPerFloor)의 합을 '층당세대'(unitsPerFloor)에 반영.
 * 층당세대는 템플릿 매스의 footprint 폭을 결정하므로 합이 바뀌면 매스도 재생성한다
 * (custom 매스는 DXF 원본 형상 유지 — 숫자만 갱신).
 */
function syncUnitsPerFloorFromMix(b: Building): void {
  const sum = b.unitMix.reduce(
    (s, m) => s + Math.max(0, Math.round(m.countPerFloor)),
    0,
  );
  const next = Math.max(1, Math.min(20, sum));
  if (sum < 1 || next === b.unitsPerFloor) return;
  b.unitsPerFloor = next;
  if (b.massType !== "custom") {
    b.footprint = templateFootprint(b.massType, b.unitsPerFloor, b.segments);
  }
  rebuildOne(b);
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  refreshUpfInput(b);
}

function refreshList(): void {
  renderBuildingList(project.buildings, selectedId, computeStatusMap(), withHistory({
    onParamsChange: (b) => {
      rebuildOne(b);
      updateRotationHandle();
      invalidateAnalysis();
      updateSetbackChecks();
      updateSiteTotals();
    },
    onSelect: (id) => selectBuilding(id),
    onMassParamsChange: (b) => {
      // M6: 층당 세대·분절 수가 템플릿 footprint 크기를 결정 — 재생성 후 재구축
      if (b.massType !== "custom") {
        b.footprint = templateFootprint(b.massType, b.unitsPerFloor, b.segments);
      }
      rebuildOne(b);
      updateRotationHandle();
      invalidateAnalysis();
      updateSetbackChecks();
      updateSiteTotals();
    },
    onUnitMixChange: (b) => {
      syncUnitsPerFloorFromMix(b);
      updateSiteTotals();
    },
    onUnitMixAdd: (b) => {
      b.unitMix.push({ unitType: `평형${b.unitMix.length + 1}`, countPerFloor: 0 });
      syncUnitsPerFloorFromMix(b);
      refreshList();
    },
    onUnitMixRemove: (b, index) => {
      b.unitMix.splice(index, 1);
      syncUnitsPerFloorFromMix(b);
      refreshList();
    },
    onOffsetChange: (b) => {
      refreshTerrainElevation(b); // M7 — 이동하면 지형 고도(G.L.)도 갱신
      const g = groups.get(b.id);
      if (g) applyOffset(g, b);
      updateRotationHandle();
      invalidateAnalysis();
      updateSetbackChecks();
    },
    onResetOffset: (b) => {
      b.offset.dx = 0;
      b.offset.dy = 0;
      b.offset.rotation = 0;
      refreshTerrainElevation(b);
      const g = groups.get(b.id);
      if (g) applyOffset(g, b);
      refreshList();
      updateRotationHandle();
      invalidateAnalysis();
      updateSetbackChecks();
    },
    onMirror: (b, axis) => {
      // footprint·windowSegments를 함께 반전 — 창면 정합 유지 (buildings.ts 불변식)
      mirrorBuilding(b, axis);
      rebuildOne(b);
      refreshMirrorInfo(b);
      updateRotationHandle();
      invalidateAnalysis();
      updateSetbackChecks();
      setStatus(`${b.name} 미러 적용 — ${mirrorLabel(b)}`);
    },
    onDelete: (b) => deleteBuilding(b),
    onDuplicate: (b) => duplicateBuilding(b),
    isPlanLocked: () => planLocked,
    onTogglePlanLock: () => setPlanLocked(!planLocked),
    onFacilityChange: () => {
      clearFacility("시설 용도·교실 층이 바뀌어 결과가 초기화되었습니다. 다시 실행하세요.");
      refreshList();
    },
  }));
  updateSiteTotals();
}

// ---------- 되돌리기·다시하기 ----------
// 건물 배치·층수·용도·대지면적 같은 사용자 편집을 통째 스냅샷(JSON)으로 쌓는다.
// 파일을 새로 열거나 DXF를 불러오면 기록을 새로 시작한다(오버레이·지형까지 되돌리지는 않음).

const HISTORY_MAX = 80;
let history: string[] = [];
let historyIdx = -1;
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;

function historySnapshot(): string {
  return JSON.stringify({
    buildings: project.buildings,
    siteAreaM2: project.site.siteAreaM2,
    canopies: project.canopies,
    trees: project.trees,
  });
}

function updateUndoButtons(): void {
  undoBtn.disabled = historyIdx <= 0;
  redoBtn.disabled = historyIdx >= history.length - 1;
}

function resetHistory(): void {
  history = [historySnapshot()];
  historyIdx = 0;
  updateUndoButtons();
}

/** 편집이 끝난 시점에 부른다 — 바뀐 게 없으면 쌓지 않는다 */
function commitHistory(): void {
  const snap = historySnapshot();
  if (history[historyIdx] === snap) return;
  history = history.slice(0, historyIdx + 1);
  history.push(snap);
  if (history.length > HISTORY_MAX) history.shift();
  historyIdx = history.length - 1;
  updateUndoButtons();
}

function restoreHistory(idx: number): void {
  if (idx < 0 || idx >= history.length) return;
  const d = JSON.parse(history[idx]) as {
    buildings: Building[];
    siteAreaM2: number;
    canopies?: Canopy[];
    trees?: Tree[];
  };
  historyIdx = idx;
  project.buildings = d.buildings;
  project.canopies = d.canopies ?? [];
  project.trees = d.trees ?? [];
  project.site.siteAreaM2 = d.siteAreaM2;
  siteAreaInput.value = String(d.siteAreaM2);
  if (selectedId && !project.buildings.some((b) => b.id === selectedId)) selectedId = null;
  hideSunProbe();
  rebuildAll();
  refreshList();
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  updateUndoButtons();
  notifyProjectLoaded(); // 차양·가로수 다시 그리기
}

function undo(): void {
  if (historyIdx <= 0) return;
  restoreHistory(historyIdx - 1);
  setStatus("되돌렸습니다.");
}

function redo(): void {
  if (historyIdx >= history.length - 1) return;
  restoreHistory(historyIdx + 1);
  setStatus("다시 실행했습니다.");
}

/** 목록·상세 패널 편집 콜백이 끝날 때마다 기록을 쌓도록 감싼다 (선택·조회용 콜백은 제외) */
function withHistory(cb: UiCallbacks): UiCallbacks {
  const skip = new Set(["onSelect", "isPlanLocked", "onTogglePlanLock"]);
  const out = { ...cb } as Record<string, unknown>;
  for (const [k, fn] of Object.entries(cb)) {
    if (skip.has(k) || typeof fn !== "function") continue;
    out[k] = (...args: unknown[]) => {
      const r = (fn as (...a: unknown[]) => unknown)(...args);
      commitHistory();
      return r;
    };
  }
  return out as unknown as UiCallbacks;
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const t = e.target as HTMLElement | null;
  // 입력칸 안에서는 브라우저 기본 되돌리기(글자 단위)를 쓴다
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
});

/** 장면에서 건물 인스턴스 하나를 제거 (라이브러리에는 영향 없음 — 다시 추가 가능) */
function deleteBuilding(b: Building): void {
  const idx = project.buildings.findIndex((x) => x.id === b.id);
  if (idx < 0) return;
  project.buildings.splice(idx, 1);
  const g = groups.get(b.id);
  if (g) {
    viewer.buildingsRoot.remove(g);
    disposeGroup(g);
    groups.delete(b.id);
  }
  cloneOrigin.delete(b.id);
  if (selectedId === b.id) selectedId = null;
  refreshList();
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  setStatus(`${b.name} 삭제됨`);
}

/** 같은 footprint·평형구성의 새 인스턴스를 장면에 복제 (겹치지 않게 남쪽으로 살짝 이동) */
/** 계획주동 고정/이동 전환 */
function setPlanLocked(v: boolean, quiet = false): void {
  planLocked = v;
  if (v) {
    drag = null;
    rotate = null;
  }
  refreshList();
  updateRotationHandle();
  if (!quiet) {
    setStatus(v
      ? "계획주동을 도면 위치에 고정했습니다 — 목록의 '동 이동하기'로 다시 움직일 수 있습니다."
      : "계획주동 이동 가능 — 3D에서 동을 끌어 이동, 주황 고리 구슬로 회전합니다.");
  }
}

function duplicateBuilding(b: Building): void {
  // 복제한 동은 옮겨야 쓸모가 있으므로 이동 가능 상태로 바꾼다
  if (planLocked) setPlanLocked(false, true);
  sceneSeq++;
  const clone: Building = {
    ...b,
    id: `dup-${sceneSeq}-${b.id}`,
    name: `${b.name} 사본`,
    footprint: b.footprint.map((p) => ({ ...p })),
    unitMix: b.unitMix.map((m) => ({ ...m })),
    windowSegments: b.windowSegments.map(([a, c]) => [{ ...a }, { ...c }] as [Point2, Point2]),
    offset: { ...b.offset, dy: b.offset.dy - 20 },
  };
  const origin = cloneOrigin.get(b.id);
  if (origin) cloneOrigin.set(clone.id, origin);
  project.buildings.push(clone);
  rebuildOne(clone);
  selectBuilding(clone.id);
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  setStatus(`${clone.name} 복제됨`);
}

// ---------- DXF 로드 ----------
// data/DXF_RULES.md 규약 — SITE_BOUNDARY 등은 건물이 아닌 참고용 오버레이 선으로 분리.
// 여러 DXF를 나눠 그린 경우 "추가 DXF 불러오기"로 병합 — 같은 WCS 공유 전제이므로
// 최초 로드에서 계산한 원점 보정값(sceneOrigin)을 재사용해야 서로 어긋나지 않는다.

/** 병합 시 서로 다른 파일에서 온 건물 id가 충돌하지 않도록 로드 회차를 접두어로 붙인다 */
let dxfLoadSeq = 0;
let sceneOrigin: Point2 | null = null;

function rebuildOverlays(): void {
  viewer.overlaysRoot.clear();
  // 지형이 보이면 선을 지형 표면에 얹는다 — 고정 높이면 15~30m 지형 아래에 묻힌다
  viewer.overlaysRoot.add(
    createOverlayGroup(
      project.siteOverlays,
      terrainVisible ? terrainSampler() : undefined,
      terrainVisible ? drapeSurface() : undefined,
    ),
  );
  applyTerrainVisibility(); // 새로 만든 site-fill에 지형 표시 상태(채움 숨김) 재적용
}

/**
 * 대지경계로 대지면적(㎡) 계산 — 다른 대지경계를 품은 바깥 외곽선(구역계를 획지로 다시 나눠
 * 그린 경우)은 빼고, 서로 포함되지 않는 획지 면적만 더한다. 같은 땅을 두 번 세지 않기 위함.
 */
function outerSiteArea(overlays: OverlayLine[]): number {
  const sites = overlays.filter((o) => o.layer === "SITE_BOUNDARY" && o.points.length >= 3);
  const area = (o: OverlayLine) => Math.abs(signedArea(o.points));
  const center = (o: OverlayLine) => ({
    x: o.points.reduce((s, p) => s + p.x, 0) / o.points.length,
    y: o.points.reduce((s, p) => s + p.y, 0) / o.points.length,
  });
  let sum = 0;
  for (const o of sites) {
    const isContainer = sites.some((t) => {
      if (t === o || area(t) >= area(o)) return false;
      const c = center(t);
      return pointInPolygon(c.x, c.y, o.points);
    });
    if (!isContainer) sum += area(o);
  }
  return sum;
}

function loadDxfText(text: string, sourceName: string, merge: boolean): void {
  const unitMode = (document.getElementById("unit-select") as HTMLSelectElement)
    .value as UnitMode;
  try {
    const { buildings, overlays, contourPoints, warnings, unitSource, floorsFromText, unitsFromDrawing } = parseDxfBuildings(
      text,
      unitMode,
    );
    dxfLoadSeq++;
    for (const b of buildings) b.id = `L${dxfLoadSeq}-${b.id}`;

    if (merge && sceneOrigin) {
      applyRecenterOffset(sceneOrigin, buildings, overlays, contourPoints);
      project.siteOverlays.push(...overlays);
      project.terrainPoints.push(...contourPoints);
    } else {
      sceneOrigin = computeRecenterOffset(buildings, overlays);
      applyRecenterOffset(sceneOrigin, buildings, overlays, contourPoints);
      project.siteOverlays = overlays;
      project.terrainPoints = contourPoints;
      // 새 프로젝트 시작 — 장면·라이브러리 모두 초기화
      project.buildings = [];
      project.buildingLibrary = [];
      libraryCheckedIds.clear();
      cloneOrigin.clear();
      selectedId = null;
    }

    // 배치도를 통째로 불러오는 흐름 — 주동·인접건물 모두 도면 위치 그대로 장면에 놓는다.
    // 주동은 라이브러리에도 남겨 두어 복제·추가 배치에 쓸 수 있게 한다(이미 배치했으므로 선택은 해제).
    const planBuildings = buildings.filter((b) => b.type === "계획주동");
    const adjBuildings = buildings.filter((b) => b.type === "인접건물");
    project.buildingLibrary.push(...planBuildings);
    const placedPlans = planBuildings.map((lib) => cloneBuildingFromLibrary(lib, 0));
    project.buildings.push(...placedPlans, ...adjBuildings);

    // 대지면적이 비어 있으면 대지경계로 채운다 — 사용자가 직접 넣은 값은 덮어쓰지 않는다
    let autoSiteArea = 0;
    if (!(project.site.siteAreaM2 > 0)) {
      autoSiteArea = outerSiteArea(project.siteOverlays);
      if (autoSiteArea > 0) {
        siteAreaInput.value = String(Math.round(autoSiteArea));
        project.site.siteAreaM2 = Math.round(autoSiteArea);
      }
    }

    rebuildTerrain(); // rebuildAll보다 먼저 — 건물 G.L. 계산이 terrainModel을 참조
    rebuildAll();
    rebuildOverlays();
    viewer.fitToBuildings();
    refreshList();
    refreshLibraryList();
    updateRotationHandle();
    invalidateAnalysis();
    updateSetbackChecks();
    updateSiteTotals();
    const winCount = buildings.reduce((s, b) => s + b.windowSegments.length, 0);
    let msg =
      `${sourceName} ${merge ? "병합" : "불러옴"} (${unitSourceLabel(unitSource)}) — ` +
      `도면 위치 그대로 계획주동 ${planBuildings.length}동 · 인접건물 ${adjBuildings.length}동 배치` +
      (floorsFromText > 0 ? ` (층수 문자 반영 ${floorsFromText}동, 나머지 1층 — 목록에서 층수 입력)` : ` (층수 정보 없는 동은 1층 — 목록에서 층수 입력)`);
    if (unitsFromDrawing > 0) msg += `, 평형 구성 반영 ${unitsFromDrawing}동(UNIT_ 전용공간)`;
    if (autoSiteArea > 0) msg += `, 대지면적 ${Math.round(autoSiteArea).toLocaleString()}㎡ 자동 입력`;
    if (overlays.length > 0) msg += `, 오버레이 ${overlays.length}개`;
    if (winCount > 0) msg += `, 창면 ${winCount}개`;
    if (terrainModel) {
      msg += `, 지형 로드됨 (고도 범위: ${terrainModel.minZ.toFixed(1)}m ~ ${terrainModel.maxZ.toFixed(1)}m)`;
    }
    if (warnings.length > 0) msg += ` (알림 ${warnings.length}건 — "자세히")`;
    // 진단표 — 레이어 인식 현황 (기본 설정 > 도면 진단표)
    const diag = diagnoseDxfText(text);
    const winOf = (t: string) => buildings.filter((b) => b.type === t).reduce((a, b) => a + b.windowSegments.length, 0);
    lastDiagHtml = diagnosisHtml(diag, {
      fileName: sourceName,
      plans: planBuildings.length,
      adj: adjBuildings.length,
      planWinMatched: winOf("계획주동"),
      adjWinMatched: winOf("인접건물"),
      floorsFromText,
      overlays: overlays.length,
      contourPoints: contourPoints.length,
      warnings,
    });
    lastDxfName = sourceName;
    const unknown = diag.layers.filter((l) => l.category.startsWith("미인식")).length;
    if (unknown > 0) msg += ` · 미인식 레이어 ${unknown}개 (도면 진단표 참고)`;
    setStatus(msg, warnings.length > 0 ? warnings.join("\n\n") : undefined);
    for (const w of warnings) console.warn("[DXF]", w);
    if (merge) commitHistory();
    else resetHistory();
    notifyProjectLoaded();
    if (planBuildings.length > 0) askPlanLock(planBuildings.length);
  } catch (err) {
    setStatus(`불러오기 실패: ${(err as Error).message}`);
    console.error(err);
  }
}

// ---------- 층수 일괄 입력 · 법규 최대 층수 ----------
const floorsModal = document.getElementById("floors-modal") as HTMLElement;
let mfPending: MaxFloorResult[] | null = null;

function planBuildingsByType(): Map<string, Building[]> {
  const m = new Map<string, Building[]>();
  for (const b of project.buildings) {
    if (b.type !== "계획주동") continue;
    const t = planTypeOf(b.name);
    const l = m.get(t);
    if (l) l.push(b);
    else m.set(t, [b]);
  }
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)));
}

/** 층수·필로티 바뀐 동들 다시 그리기 + 검토 갱신 + 되돌리기 기록 */
function afterFloorsChanged(changed: Building[]): void {
  for (const b of changed) rebuildOne(b);
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  refreshList();
  commitHistory();
}

function renderFloorsTypes(): void {
  const host = document.getElementById("floors-types")!;
  const groups = planBuildingsByType();
  if (groups.size === 0) {
    host.innerHTML = `<p class="hint">장면에 계획주동이 없습니다.</p>`;
    return;
  }
  const range = (bs: Building[]) => {
    const fs = bs.map((b) => b.floors);
    const lo = Math.min(...fs), hi = Math.max(...fs);
    return lo === hi ? `${lo}층` : `${lo}~${hi}층`;
  };
  const all = [...groups.values()].flat();
  const rows: [string, Building[]][] = [["전체", all], ...groups];
  host.innerHTML =
    `<table class="ft-table"><tr><th>타입</th><th>동 수</th><th>현재</th><th>층수</th><th>필로티</th><th></th></tr>` +
    rows
      .map(
        ([t, bs], i) =>
          `<tr><td>${t === "전체" ? "<b>전체 계획주동</b>" : `${t} 타입`}</td><td>${bs.length}</td><td>${range(bs)}</td>` +
          `<td><input type="number" min="1" max="99" step="1" data-ft-floors="${i}" placeholder="${bs[0].floors}" /></td>` +
          `<td><input type="number" min="0" max="5" step="1" data-ft-piloti="${i}" placeholder="${bs[0].pilotiFloors}" /></td>` +
          `<td><button class="btn mini" data-ft-apply="${i}">적용</button></td></tr>`,
      )
      .join("") +
    `</table>`;
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-ft-apply]")) {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.ftApply);
      const bs = rows[i][1];
      const fIn = host.querySelector<HTMLInputElement>(`[data-ft-floors="${i}"]`)!;
      const pIn = host.querySelector<HTMLInputElement>(`[data-ft-piloti="${i}"]`)!;
      const f = parseInt(fIn.value, 10);
      const pl = parseInt(pIn.value, 10);
      if (!Number.isFinite(f) && !Number.isFinite(pl)) {
        setStatus("층수나 필로티 값을 넣으세요.");
        return;
      }
      for (const b of bs) {
        if (Number.isFinite(f)) b.floors = Math.max(1, Math.min(99, f));
        if (Number.isFinite(pl)) b.pilotiFloors = Math.max(0, Math.min(b.floors - 1, pl));
      }
      afterFloorsChanged(bs);
      setStatus(`${rows[i][0] === "전체" ? "전체 계획주동" : `${rows[i][0]} 타입`} ${bs.length}동 — ` +
        (Number.isFinite(f) ? `${f}층` : "") + (Number.isFinite(pl) ? ` 필로티 ${pl}층` : "") + " 적용");
      renderFloorsTypes();
    });
  }
  const sel = document.getElementById("mf-target") as HTMLSelectElement;
  sel.innerHTML = rows.map(([t], i) => `<option value="${i}">${t === "전체" ? "전체 계획주동" : `${t} 타입`}</option>`).join("");
}

let tpPending: TentResult | null = null;
let tpGfa: { retailM2: number; amenityPerUnit: number } | null = null;
let tpUpf: Map<string, number> | null = null;

document.getElementById("floors-tool-btn")!.addEventListener("click", () => {
  renderFloorsTypes();
  // 근생·부대는 기본 설정 값과 같은 것을 쓴다 (비어 있으면 개략 기본값 제안)
  const retail = document.getElementById("tp-retail") as HTMLInputElement;
  const amen = document.getElementById("tp-amenity") as HTMLInputElement;
  const ex = project.analysis.gfaExtra;
  const dflt = defaultTentOptions(project.site.siteAreaM2);
  retail.value = String(ex && ex.retailM2 > 0 ? ex.retailM2 : dflt.retailM2);
  amen.value = String(ex && ex.amenityPerUnit > 0 ? ex.amenityPerUnit : dflt.amenityPerUnit);
  tpPending = null;
  (document.getElementById("tp-result") as HTMLElement).innerHTML = "";
  (document.getElementById("tp-apply") as HTMLElement).hidden = true;
  mfPending = null;
  (document.getElementById("mf-result") as HTMLElement).innerHTML = "";
  (document.getElementById("mf-apply") as HTMLElement).hidden = true;
  floorsModal.hidden = false;
});
document.getElementById("floors-close")!.addEventListener("click", () => {
  floorsModal.hidden = true;
});

document.getElementById("mf-run")!.addEventListener("click", async () => {
  const groups = planBuildingsByType();
  const rows: Building[][] = [[...groups.values()].flat(), ...groups.values()];
  const idx = Number((document.getElementById("mf-target") as HTMLSelectElement).value) || 0;
  const targets = rows[idx] ?? [];
  if (targets.length === 0) return;
  const cap = Math.max(1, Math.min(99, parseInt((document.getElementById("mf-cap") as HTMLInputElement).value, 10) || 35));
  syncSetbackRules();
  // 실제 배치를 건드리지 않도록 복제본에서 찾는다
  const sim = { ...project, buildings: structuredClone(project.buildings) } as typeof project;
  const runBtn = document.getElementById("mf-run") as HTMLButtonElement;
  runBtn.disabled = true;
  const out = document.getElementById("mf-result") as HTMLElement;
  try {
    const res = await findMaxFloors(
      sim,
      targets.map((b) => b.id),
      cap,
      (d, t) => {
        out.innerHTML = `<p class="hint">찾는 중… ${Math.round((d / t) * 100)}%</p>`;
      },
      yieldToEventLoop,
    );
    mfPending = res;
    out.innerHTML =
      `<table class="ft-table"><tr><th>동</th><th>현재</th><th>최대</th><th>더 올리면 걸리는 기준</th><th>층수와 무관한 기존 위반</th></tr>` +
      res
        .map(
          (r) =>
            `<tr><td>${r.name}</td><td>${r.before}층</td>` +
            `<td class="${r.max > r.before ? "up" : r.max < r.before ? "down" : ""}">${r.max}층</td><td>${r.limit === "한도" ? `한도(${cap}층)` : r.limit}</td>` +
            `<td class="${r.fixedViolations ? "down" : ""}">${r.fixedViolations ? `${r.fixedViolations}건 — 배치 조정 필요` : "—"}</td></tr>`,
        )
        .join("") +
      `</table><p class="hint">합계 ${res.reduce((s, r) => s + r.before, 0)}층 → ${res.reduce((s, r) => s + r.max, 0)}층 (동별 층수 합). ` +
      `"기존 위반"은 측벽 4m·창 없는 벽 8m처럼 높이와 무관한 거리 기준이라 층수로 해결되지 않습니다.</p>`;
    (document.getElementById("mf-apply") as HTMLElement).hidden = false;
  } finally {
    runBtn.disabled = false;
  }
});

document.getElementById("tp-run")!.addEventListener("click", async () => {
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  if (!plans.length) {
    setStatus("장면에 계획주동이 없습니다.");
    return;
  }
  const num = (id: string, d: number) => {
    const v = parseFloat((document.getElementById(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : d;
  };
  const kind = (document.getElementById("tp-kind") as HTMLSelectElement).value as "far" | "units";
  if (kind === "far" && !(project.site.siteAreaM2 > 0)) {
    setStatus("용적률 목표에는 대지면적이 필요합니다 — 기본 설정에서 대지면적을 넣으세요.");
    return;
  }
  const o: TentOptions = {
    target: { kind, value: num("tp-value", 300) },
    retailM2: Math.max(0, num("tp-retail", 0)),
    amenityPerUnit: Math.max(0, num("tp-amenity", 3)),
    maxFloors: Math.max(1, Math.round(num("tp-max", 35))),
    minFloors: Math.max(1, Math.round(num("tp-min", 7))),
    edgeFactor: num("tp-edge", 1),
    assumedAdjFloors: Math.max(0, num("tp-assume", 10)),
    edgeRadius: num("tp-radius", 100),
    shape: num("tp-shape", 1),
    areaPerUnit: num("tp-apu", 110),
    northWeight: num("tp-north", 0.5),
    towerMinArea: num("tp-tarea", 400),
    towerMaxAspect: num("tp-tasp", 1.4),
    slabRatio: num("tp-slab", 60) / 100,
    tierStep: num("tp-tier", 5),
    allowRelax: (document.getElementById("tp-relax") as HTMLInputElement).checked,
  };
  if (o.minFloors > o.maxFloors) o.minFloors = o.maxFloors;
  syncSetbackRules();
  const out = document.getElementById("tp-result") as HTMLElement;
  const runBtn = document.getElementById("tp-run") as HTMLButtonElement;
  runBtn.disabled = true;
  try {
    // 규칙(텐트·남저북고·탑상/판상·단계) → 우선순위 법규 맞춤으로 목표를 채우는 가장 낮은 최고층
    const res = await planTentLegal(
      project,
      o,
      (msg) => {
        out.innerHTML = `<p class="hint">${msg}…</p>`;
      },
      yieldToEventLoop,
    );
    // 법규로 낮아진 동 — 한 층 더 올리면 무엇에 걸리는지
    const reasons = new Map<string, number>();
    {
      const sim = { ...project, buildings: structuredClone(project.buildings) } as typeof project;
      for (const r of res.rows) {
        const b = sim.buildings.find((x) => x.id === r.id);
        if (b) b.floors = r.floors;
      }
      const plansSim = sim.buildings.filter((b) => b.type === "계획주동");
      for (const r of res.rows.filter((x) => x.capped)) {
        const b = sim.buildings.find((x) => x.id === r.id)!;
        const now = new Set(violations(sim, b, plansSim).keys());
        b.floors += 1;
        const extra = [...violations(sim, b, plansSim)].filter(([k]) => !now.has(k)).map(([, v]) => v);
        b.floors -= 1;
        const why = extra[0] ?? "인동거리";
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
      }
    }
    tpPending = res;
    tpGfa = { retailM2: o.retailM2, amenityPerUnit: o.amenityPerUnit };
    tpUpf = new Map(plans.map((b) => [b.id, unitsPerFloorOf(b, o.areaPerUnit)]));
    // 목표 미달이면 원인 설명 — 법규 한도까지 모두 올렸을 때의 최대치와 걸리는 기준
    let why = "";
    if (!res.meets) {
      const unit = kind === "far" ? "%" : "세대";
      const bv = kind === "far" ? (res.farPct ?? 0).toFixed(1) : res.units.toLocaleString();
      why =
        `<div class="tp-why"><b>왜 못 채우나요?</b> 이 배치(동 위치·바닥면적)로는 우선순위대로 법규 한도까지 올려도 ` +
        `<b>${kind === "far" ? "용적률" : "세대수"} ${bv}${unit}</b>가 한계입니다 (목표 ${o.target.value.toLocaleString()}${unit}). ` +
        (reasons.size ? `법규로 낮아진 동: ${[...reasons].map(([k, v]) => `${k} ${v}동`).join(" · ")}.<br>` : "<br>") +
        `→ 인동거리가 막으면 동 간격을, 정북사선이 막으면 북측 이격을 넓히거나, 탑상형 바닥면적을 키우거나 최고층 한도를 올려 보세요.` +
        (o.allowRelax ? "" : ` 스카이라인 규칙을 깨더라도 목표를 우선하려면 "낮은 동을 끌어올려 목표 우선"을 켜세요.`) +
        `</div>`;
    }
    const rows = [...res.rows].sort((a, b) => b.floors - a.floors || b.score - a.score);
    const targetText = kind === "far" ? `용적률 ${o.target.value}%` : `${o.target.value.toLocaleString()}세대`;
    out.innerHTML =
      (res.relaxedLift !== null
        ? `<div class="tp-why">최고 ${o.maxFloors}층 텐트로는 목표에 못 미쳐 <b>텐트를 완화</b>했습니다 — 낮은 동을 ` +
          `${res.meets ? `${res.relaxedLift}층까지` : "법규 한도까지"} 끌어올렸습니다(가운데가 높은 순서는 유지).</div>`
        : "") +
      `<p class="${res.meets ? "" : "down"}" style="font-size:13px"><b>${res.meets ? "목표 충족" : "목표 미달"}</b> — ${targetText} 기준 · 최고 ${res.peak}층 · ` +
      `세대 ${res.units.toLocaleString()} · 용적률 ${res.farPct === null ? "—" : res.farPct.toFixed(1) + "%"} ` +
      `(주거 ${Math.round(res.residentialM2).toLocaleString()} + 근생 ${o.retailM2.toLocaleString()} + 부대 ${Math.round(res.amenityM2).toLocaleString()}㎡)` +
      (res.meets ? "" : ` — 최고층 ${o.maxFloors}층과 법규 한도 안에서는 ${kind === "far" ? `${Math.abs(res.gap).toFixed(1)}%p` : `${Math.abs(Math.round(res.gap))}세대`} 부족합니다`) +
      `</p><table class="ft-table"><tr><th>동</th><th>형태</th><th>높이 점수</th><th>가장자리</th><th>규칙 층수</th><th>배분 (법규 반영)</th><th></th></tr>` +
      rows
        .map(
          (r) =>
            `<tr><td>${r.name}</td><td>${r.role}</td><td>${(r.score * 100).toFixed(0)}</td><td>${r.edgeFloors}층</td><td>${r.ideal}층</td>` +
            `<td class="${r.capped ? "down" : ""}">${r.floors}층${r.capped ? " (법규)" : ""}</td>` +
            `<td><span class="tent-bar${r.capped ? " cap" : ""}" style="width:${Math.round((r.floors / Math.max(1, res.peak)) * 80)}px"></span></td></tr>`,
        )
        .join("") +
      `</table><p class="hint">높이 점수 = 가운데일수록·북쪽일수록 높음(100이 가장 높은 자리). 형태: 탑상형은 점수대로 높게, 탑에 붙은 날개·떨어진 판상형은 그 비율만큼 낮게. 빨간 막대는 법규 최대 층수로 잘린 동입니다. 연면적은 개략(바닥면적 × 주거층수)입니다.</p>`;
    out.insertAdjacentHTML("afterbegin", why);
    (document.getElementById("tp-apply") as HTMLElement).hidden = false;
  } finally {
    runBtn.disabled = false;
  }
});

document.getElementById("tp-apply")!.addEventListener("click", () => {
  if (!tpPending) return;
  const changed: Building[] = [];
  let estimated = 0;
  for (const r of tpPending.rows) {
    const b = project.buildings.find((x) => x.id === r.id);
    if (!b) continue;
    b.floors = r.floors;
    // 평형 구성이 없는 동은 세대수 표에 잡히도록 추정 평형으로 층당 세대를 넣는다
    if (b.unitMix.reduce((s, m) => s + m.countPerFloor, 0) <= 0 && tpUpf?.get(b.id)) {
      b.unitMix = [{ unitType: "추정", countPerFloor: tpUpf.get(b.id)! }];
      b.unitsPerFloor = tpUpf.get(b.id)!;
      estimated++;
    }
    changed.push(b);
  }
  // 배분에 쓴 근생·부대 면적을 기본 설정에도 반영 — 화면 아래 용적률과 같은 값이 되게
  if (tpGfa) {
    project.analysis.gfaExtra = { ...tpGfa };
    gfaRetailInput.value = String(tpGfa.retailM2);
    gfaAmenityInput.value = String(tpGfa.amenityPerUnit);
  }
  afterFloorsChanged(changed);
  setStatus(
    `신통기획 자동 배분 적용 — ${changed.length}동, 최고 ${tpPending.peak}층` +
      (estimated ? ` · 평형 구성이 없던 ${estimated}동은 "추정" 평형으로 층당 세대를 넣었습니다` : "") +
      ` (일조권은 따로 검토하세요)`,
  );
  tpPending = null;
  (document.getElementById("tp-apply") as HTMLElement).hidden = true;
  renderFloorsTypes();
});

document.getElementById("mf-apply")!.addEventListener("click", () => {
  if (!mfPending) return;
  const changed: Building[] = [];
  for (const r of mfPending) {
    const b = project.buildings.find((x) => x.id === r.id);
    if (b && b.floors !== r.max) {
      b.floors = r.max;
      changed.push(b);
    }
  }
  afterFloorsChanged(changed);
  setStatus(`법규 최대 층수 적용 — ${changed.length}동 변경 (일조권은 따로 검토하세요)`);
  mfPending = null;
  (document.getElementById("mf-apply") as HTMLElement).hidden = true;
  renderFloorsTypes();
});

// ---------- 보고서 PDF ----------
let lastDxfName = "";

interface FigureSource {
  title: string;
  objs: () => (THREE.Object3D | null | undefined)[];
  legendPrefix?: string[];
  entryTitles: string[];
}

function mainFigureSources(): FigureSource[] {
  const out: FigureSource[] = [];
  if (lastNorthSetback)
    out.push({ title: "법규 검토 — 정북사선·채광사선·인동거리", objs: () => [northSetbackRoot, daylightRoot, spacingRoot], entryTitles: ["정북사선", "채광사선", "인동거리"] });
  if (lastSunHours) out.push({ title: "일조권 (인접건물)", objs: () => [sunHoursRoot], legendPrefix: ["일조권 —"], entryTitles: ["일조권 (인접건물)"] });
  if (lastFacility) out.push({ title: "유치원·학교·교회 일조", objs: () => [facilityGroup], legendPrefix: ["유치원·학교·교회"], entryTitles: ["유치원·학교·교회 일조"] });
  if (lastSunHoursMap) out.push({ title: "일조시간 지도", objs: () => [sunHoursMapGroup], legendPrefix: ["일조시간 지도"], entryTitles: [`일조시간 지도 (${lastSunHoursMap.date})`] });
  if (lastWind) out.push({ title: "바람길 (간이)", objs: () => [windGroup], legendPrefix: ["바람길 —"], entryTitles: ["바람길 (간이)"] });
  if (lastLbm) out.push({ title: "바람길 LBM", objs: () => [lbmStreamGroup, lbmHeatmap?.mesh], legendPrefix: ["바람길 LBM"], entryTitles: ["바람길 LBM"] });
  return out;
}

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.readAsDataURL(b);
  });
}

document.getElementById("export-report")!.addEventListener("click", async () => {
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  // 팝업 차단을 피하려고 클릭 즉시 창을 연다
  const win = window.open("", "_blank");
  if (!win) {
    setStatus("팝업이 차단되었습니다 — 이 사이트의 팝업을 허용해 주세요.");
    return;
  }
  win.document.write(`<p style="font-family:sans-serif;padding:20px">보고서를 만드는 중…</p>`);
  setStatus("보고서 그림을 만드는 중…");
  syncAllSettings();
  const mains = mainFigureSources();
  const mods = getAnalyses().filter((m) => m.hasResult());
  // 결과 표시 상태 보관 → 그림마다 그 분석만 켜고 캡처 → 복원
  const allObjs = mains.flatMap((f) => f.objs()).filter((o): o is THREE.Object3D => !!o);
  const vis = allObjs.map((o) => o.visible);
  const hideAll = () => {
    for (const o of allObjs) o.visible = false;
    for (const m of mods) m.setVisible?.(false);
  };
  const capture = async (legends: LegendItem[]) =>
    blobToDataUrl(
      await viewer.captureJpeg(
        0.9,
        (ctx, w, h, sc) => {
          drawLegendsOnCanvas(ctx, legends, h, sc);
          drawCompassAndScale(ctx, w, h, sc);
        },
        { whiteBackground: true }, // 인쇄용 — 흰 배경
      ),
    );
  const boardAll = [...mainBoardEntries(), ...analysisBoard()];
  const figures: ReportFigure[] = [];
  let cover: string | undefined;
  try {
    hideAll();
    cover = await capture([]);
    const legendsMain = currentLegends();
    for (const f of mains) {
      hideAll();
      for (const o of f.objs()) if (o) o.visible = true;
      const lg = f.legendPrefix ? legendsMain.filter((l) => f.legendPrefix!.some((p) => l.title.startsWith(p))) : [];
      const entries = boardAll.filter((e) => f.entryTitles.includes(e.title));
      const merged = entries.length > 1
        ? { title: f.title, value: entries.map((e) => `${e.title} ${e.value}`).join(" · "), verdict: entries.some((e) => e.verdict === "bad") ? ("bad" as const) : ("ok" as const), items: entries.flatMap((e) => e.items ?? []) }
        : entries[0] ?? null;
      figures.push({ title: f.title, image: await capture(lg), entry: merged });
    }
    for (const m of mods) {
      const entry = m.board();
      if (m.setVisible) {
        hideAll();
        m.setVisible(true);
        figures.push({ title: m.title, image: await capture(m.legends()), entry, html: m.reportHtml?.() });
      } else {
        figures.push({ title: m.title, html: m.reportHtml?.(), entry });
      }
    }
  } finally {
    allObjs.forEach((o, i) => (o.visible = vis[i]));
    for (const m of mods) m.setVisible?.(true);
    if (lbmHeatmap) lbmHeatmap.mesh.visible = lbmHeatmapChk.checked;
    if (lbmStreamGroup) lbmStreamGroup.visible = lbmStreamChk.checked;
  }
  const t = siteUnitTotals(project.buildings);
  const cov = coverageStats(project.buildings, project.site.siteAreaM2, project.analysis.gfaExtra);
  const now = new Date();
  const html = buildReportHtml({
    title: `배치 검토 보고서${lastDxfName ? ` — ${lastDxfName.replace(/\.dxf$/i, "")}` : ""}`,
    generatedAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    info: [
      ["기준일", project.analysis.date],
      ["위치", `위도 ${project.site.latitude.toFixed(4)} · 경도 ${project.site.longitude.toFixed(4)}`],
      ["계획주동", `${t.buildingCount}동 · ${t.total.toLocaleString()}세대`],
      ["연면적", `${Math.round(cov.grossM2).toLocaleString()}㎡`],
      ["대지면적", project.site.siteAreaM2 > 0 ? `${project.site.siteAreaM2.toLocaleString()}㎡` : "미입력"],
      ["건폐율 · 용적률", cov.bcrPct === null ? "대지면적 미입력" : `${cov.bcrPct.toFixed(1)}% · ${cov.farPct?.toFixed(1)}%`],
      ["층수 범위", (() => { const fs = project.buildings.filter((b) => b.type === "계획주동").map((b) => b.floors); return fs.length ? `${Math.min(...fs)}~${Math.max(...fs)}층` : "—"; })()],
    ],
    summary: boardAll,
    cover,
    figures,
  });
  win.document.open();
  win.document.write(html);
  win.document.close();
  // 이미지가 다 그려진 뒤 인쇄 창 — 사용자가 "PDF로 저장"을 고른다
  win.addEventListener("load", () => setTimeout(() => win.print(), 300));
  setStatus(`보고서를 만들었습니다 — 그림 ${figures.length + 1}장. 새 창의 인쇄 화면에서 "PDF로 저장"을 고르세요.`);
});

// ---------- 도면 진단표 ----------
let lastDiagHtml: string | null = null;
document.getElementById("dxf-diag-btn")!.addEventListener("click", () => {
  const modal = document.getElementById("diag-modal") as HTMLElement;
  (document.getElementById("diag-body") as HTMLElement).innerHTML =
    lastDiagHtml ?? `<p class="hint">아직 불러온 DXF가 없습니다.</p>`;
  modal.hidden = false;
});
document.getElementById("diag-close")!.addEventListener("click", () => {
  (document.getElementById("diag-modal") as HTMLElement).hidden = true;
});

const lockModal = document.getElementById("lock-modal") as HTMLElement;

/** DXF를 불러온 뒤 계획주동을 고정할지 묻는다 — 답하기 전까지는 고정(실수로 밀리지 않게) */
function askPlanLock(count: number): void {
  planLocked = true;
  refreshList();
  updateRotationHandle();
  const summary = document.getElementById("lock-summary");
  if (summary) summary.textContent = `계획주동 ${count}동을 도면 위치 그대로 불러왔습니다.`;
  lockModal.hidden = false;
}
document.getElementById("lock-fixed")!.addEventListener("click", () => {
  lockModal.hidden = true;
  setPlanLocked(true);
});
document.getElementById("lock-movable")!.addEventListener("click", () => {
  lockModal.hidden = true;
  setPlanLocked(false);
});

// ---------- 건물 라이브러리 — 기본 샘플 템플릿 + DXF 템플릿, 선택 추가/전체 선택/해제 ----------

/** 라이브러리 패널 상단에 항상 고정으로 보여줄 기본 샘플 템플릿 — DXF 로드/초기화와 무관 */
const SAMPLE_TEMPLATES: { massType: Exclude<MassType, "custom">; floors: number }[] = [
  { massType: "slab", floors: 15 },
  { massType: "tower", floors: 10 },
  { massType: "segment", floors: 20 },
];

const sampleLibrary: Building[] = SAMPLE_TEMPLATES.map(({ massType, floors }) => {
  const b = createTemplateBuilding(massType, DEFAULT_UNITS_PER_FLOOR[massType], 2, 1);
  b.id = `sample-${massType}`;
  b.floors = floors;
  b.name = `${MASS_TYPE_LABEL[massType]} 샘플 ${floors}F`;
  return b;
});

function refreshLibraryList(): void {
  renderLibraryList([...sampleLibrary, ...project.buildingLibrary], libraryCheckedIds, (id, checked) => {
    if (checked) libraryCheckedIds.add(id);
    else libraryCheckedIds.delete(id);
  });
}

/** 라이브러리 건물을 장면용 인스턴스로 복제 — 처음 추가면 DXF 원위치(offset 0), 재추가면 겹치지 않게 stagger */
function cloneBuildingFromLibrary(lib: Building, stagger: number): Building {
  sceneSeq++;
  const clone: Building = {
    ...lib,
    id: `scene-${sceneSeq}-${lib.id}`,
    footprint: lib.footprint.map((p) => ({ ...p })),
    unitMix: lib.unitMix.map((m) => ({ ...m })),
    windowSegments: lib.windowSegments.map(([a, c]) => [{ ...a }, { ...c }] as [Point2, Point2]),
    offset: { dx: 0, dy: stagger, rotation: 0 },
  };
  cloneOrigin.set(clone.id, lib.id);
  return clone;
}

document.getElementById("dxf-file")!.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  loadDxfText(await file.text(), file.name, false);
  input.value = "";
});

document.getElementById("dxf-file-add")!.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  loadDxfText(await file.text(), file.name, true);
  input.value = "";
});

// ---------- 레이어 규약 모달 ----------

const layerRulesModal = document.getElementById("layer-rules-modal")!;

document.getElementById("show-layer-rules")!.addEventListener("click", () => {
  layerRulesModal.hidden = false;
});

document.getElementById("close-layer-rules")!.addEventListener("click", () => {
  layerRulesModal.hidden = true;
});

layerRulesModal.addEventListener("click", (e) => {
  if (e.target === layerRulesModal) layerRulesModal.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !layerRulesModal.hidden) layerRulesModal.hidden = true;
});

// ---------- PV(M4/M5) 공용 설정 ----------

const latInput = document.getElementById("lat-input") as HTMLInputElement;
const lngInput = document.getElementById("lng-input") as HTMLInputElement;
const dateInput = document.getElementById("date-input") as HTMLInputElement;
const gridInput = document.getElementById("grid-input") as HTMLInputElement;

function syncAnalysisSettings(): void {
  project.site.latitude = parseFloat(latInput.value) || 37.57;
  project.site.longitude = parseFloat(lngInput.value) || 126.98;
  project.analysis.date = dateInput.value || "2026-12-21";
  project.analysis.gridSize = Math.max(0.25, parseFloat(gridInput.value) || 1);
}

for (const el of [latInput, lngInput, dateInput, gridInput]) {
  el.addEventListener("change", () => {
    syncAnalysisSettings();
    invalidateAnalysis();
    updateSunFromSlider();
  });
}

/**
 * 배치·설정이 바뀌면 기존 일조권(레이캐스팅)·PV(M4·M5) 결과를 무효화 —
 * 정북사선·채광사선·인동거리는 updateSetbackChecks()가 항상 최신 유지하므로 대상 아님.
 */
function invalidateAnalysis(): void {
  const note = "배치가 변경되어 결과가 초기화되었습니다. 다시 실행하세요.";
  if (lastSunHours) {
    lastSunHours = null;
    clearGroup(sunHoursRoot);
    renderSunHoursSummary(null, undefined, note);
    updateLegends();
    refreshStatusDots(computeStatusMap());
  }
  if (lastWind) {
    lastWind = null;
    clearWindOverlay();
    renderWindSummary(null, note);
    updateLegends();
  }
  if (lastLbm || lbmWorker) {
    resetLbm(note); // 실행 중이던 워커도 종료 — 이전 배치 기준 결과라 무효
  }
  if (lastSunHoursMap) {
    lastSunHoursMap = null;
    clearSunHoursMapOverlay();
    renderSunHoursMapSummary(null, note);
    updateLegends();
  }
  if (lastFacility) clearFacility(note);
  // 지점 일조 측정 — 배치가 바뀌면 차폐가 달라지므로 다시 만들고 떠 있던 값은 닫는다
  disposeProbeMeshes();
  hideSunProbe();
  invalidateAnalyses(note);
  updateLegends();
}

/** 교육·종교시설 창문 일조 결과 지우기 */
function clearFacility(note?: string): void {
  const had = lastFacility !== null;
  lastFacility = null;
  if (facilityGroup) {
    disposeFacilityOverlay(facilityGroup);
    facilityGroup = null;
  }
  renderFacilitySummary(null, note);
  updateLegends();
  if (had) refreshStatusDots(computeStatusMap());
}

function clearGroup(root: THREE.Group): void {
  for (const child of [...root.children]) {
    root.remove(child);
    if (child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
}

// ---------- 정북사선·채광사선·인동거리 검토 (M2/M3) ----------
// 셋 다 태양과 무관한 순수 기하 계산 — 정북사선은 항상 자동 계산되고,
// 채광사선·인동거리는 토글이 켜져 있는 동안 이동·회전 시 매번 즉시 재계산한다.

const northLowInput = document.getElementById("north-low-m") as HTMLInputElement;
const northRatioInput = document.getElementById("north-ratio") as HTMLInputElement;
const daylightRatioInput = document.getElementById(
  "daylight-ratio",
) as HTMLInputElement;
const daylightRoadParkInput = document.getElementById(
  "daylight-roadpark",
) as HTMLInputElement;
const spacingWindowInput = document.getElementById(
  "spacing-window",
) as HTMLInputElement;
const spacingNoWindowMInput = document.getElementById(
  "spacing-nowindow-m",
) as HTMLInputElement;
const spacingSideMInput = document.getElementById("spacing-side-m") as HTMLInputElement;
const presetBtn = document.getElementById("preset-toggle") as HTMLButtonElement;
const daylightBtn = document.getElementById("toggle-daylight")!;
const spacingBtn = document.getElementById("toggle-spacing")!;

let daylightOn = false;
let spacingOn = false;
/** 프리셋 토글 상태 — true면 서울시 조례 값 적용 중 */
let seoulPresetOn = false;

/** M2/M3 오버레이 루트 */
const northSetbackRoot = new THREE.Group();
const daylightRoot = new THREE.Group();
const spacingRoot = new THREE.Group();
viewer.scene.add(northSetbackRoot, daylightRoot, spacingRoot);

// 정북사선 검토선 표시 토글 — 판정(상태바·목록 도트·엑셀)은 계속 계산하고 3D 선만 숨긴다
const northLinesInput = document.getElementById("show-north-lines") as HTMLInputElement | null;
northLinesInput?.addEventListener("change", () => {
  northSetbackRoot.visible = northLinesInput.checked;
  setStatus(northLinesInput.checked ? "정북사선 검토선 표시" : "정북사선 검토선 숨김 — 판정은 계속 갱신됩니다");
});

function syncSetbackRules(): void {
  const r = project.analysis.setbackRules;
  r.northSetbackLowM = Math.max(0, parseFloat(northLowInput.value) || 1.5);
  r.northSetbackRatio = Math.max(0.1, parseFloat(northRatioInput.value) || 0.5);
  r.daylightRatio = Math.max(0.1, parseFloat(daylightRatioInput.value) || 2);
  r.daylightRoadParkRatio = Math.max(0.1, parseFloat(daylightRoadParkInput.value) || 2);
  r.spacingRatioWindow = Math.max(0.1, parseFloat(spacingWindowInput.value) || 0.5);
  r.spacingNoWindowM = Math.max(0, parseFloat(spacingNoWindowMInput.value) || 8);
  r.spacingSideM = Math.max(0, parseFloat(spacingSideMInput.value) || 4);
  r.spacingNaEnabled = spacingNaInput.checked;
  r.spacingNaHigh = Math.max(0.1, parseFloat(spacingNaHighInput.value) || 0.4);
  r.spacingNaLow = Math.max(0.1, parseFloat(spacingNaLowInput.value) || 0.5);
}

/** SetbackRules 값을 입력창에 반영 (프리셋 적용 시) */
function fillSetbackInputs(r: SetbackRules): void {
  northLowInput.value = String(r.northSetbackLowM);
  northRatioInput.value = String(r.northSetbackRatio);
  daylightRatioInput.value = String(r.daylightRatio);
  daylightRoadParkInput.value = String(r.daylightRoadParkRatio);
  spacingWindowInput.value = String(r.spacingRatioWindow);
  spacingNoWindowMInput.value = String(r.spacingNoWindowM);
  spacingSideMInput.value = String(r.spacingSideM);
  spacingNaInput.checked = r.spacingNaEnabled ?? true;
  spacingNaHighInput.value = String(r.spacingNaHigh ?? 0.4);
  spacingNaLowInput.value = String(r.spacingNaLow ?? 0.5);
}
const spacingNaInput = document.getElementById("spacing-na") as HTMLInputElement;
const spacingNaHighInput = document.getElementById("spacing-na-high") as HTMLInputElement;
const spacingNaLowInput = document.getElementById("spacing-na-low") as HTMLInputElement;
for (const el of [spacingNaInput, spacingNaHighInput, spacingNaLowInput]) {
  el.addEventListener("change", () => {
    syncSetbackRules();
    updateSetbackChecks();
  });
}

// 서울시 조례 ⇄ 시행령 기본값 프리셋 토글 — 값은 types.ts의 프리셋 함수가 단일 출처
presetBtn.addEventListener("click", () => {
  seoulPresetOn = !seoulPresetOn;
  const preset = seoulPresetOn ? seoulSetbackRules() : statutorySetbackRules();
  project.analysis.setbackRules = { ...preset };
  fillSetbackInputs(preset);
  setToggle(presetBtn, seoulPresetOn);
  presetBtn.textContent = seoulPresetOn ? "서울시 조례 적용됨 — 기본값으로" : "서울시 조례 기준 적용";
  updateSetbackChecks();
  setStatus(
    seoulPresetOn
      ? "서울시 건축조례 제60조 적용 — 채광창 벽면 인동거리 0.8배 (그 외 시행령과 동일)"
      : "건축법 시행령 제86조 기본값으로 복원",
  );
});

/**
 * 정북사선은 항상, 채광사선·인동거리는 켜져 있을 때만 다시 계산해 오버레이·요약을 갱신.
 * 오버레이는 공유 지오메트리만 쓰므로 dispose 없이 clear해도 된다.
 */
function updateSetbackChecks(): void {
  northSetbackRoot.clear();
  daylightRoot.clear();
  spacingRoot.clear();
  lastNorthSetback = runNorthSetbackCheck(project);
  lastDaylight = daylightOn ? runDaylightCheck(project) : null;
  lastSpacing = spacingOn ? runSpacingCheck(project) : null;
  const elev = terrainSampler(); // 지형 위 표시 (M7) — 판정 계산과 무관, 표시 전용
  northSetbackRoot.add(createNorthSetbackOverlay(lastNorthSetback, elev));
  if (lastDaylight) daylightRoot.add(createDaylightOverlay(lastDaylight, elev));
  if (lastSpacing) spacingRoot.add(createSpacingOverlay(lastSpacing, elev));
  renderSetbackSummary(lastNorthSetback, lastDaylight, lastSpacing);
  refreshStatusDots(computeStatusMap());
  updateLegends();
}

function setToggle(btn: HTMLElement, on: boolean): void {
  btn.classList.toggle("toggled", on);
}

/**
 * 채광사선·인동거리는 **계획주동만** 검토 대상이다(daylight.ts / spacing.ts).
 * DXF를 불러오면 계획주동은 라이브러리에만 담기고 장면에는 인접건물만 배치되므로,
 * 계획주동을 추가하기 전에 토글을 켜면 "켬"이라 해놓고 아무것도 안 그려져 고장처럼 보인다.
 * → 켜기 전에 대상 유무를 확인하고, 없으면 무엇을 해야 하는지 알려준다.
 */
function noPlanTargetMessage(what: string): string | null {
  if (project.buildings.some((b) => b.type === "계획주동")) return null;
  return project.buildings.length === 0
    ? "먼저 DXF를 불러오세요."
    : `장면에 계획주동이 없어 ${what} 검토를 켤 수 없습니다 — 계획주동만 검토하는 기능입니다. ` +
        `"건물 라이브러리"에서 주동을 선택해 "장면에 추가"하세요.`;
}

daylightBtn.addEventListener("click", () => {
  const blocked = !daylightOn && noPlanTargetMessage("채광사선");
  if (blocked) {
    setStatus(blocked);
    return;
  }
  daylightOn = !daylightOn;
  setToggle(daylightBtn, daylightOn);
  syncSetbackRules();
  updateSetbackChecks();
  setStatus(
    daylightOn
      ? "채광사선 검토 켬 — 초록=적합, 빨강=위반 (이동·회전 중 실시간 갱신)"
      : "채광사선 검토 끔",
  );
});

spacingBtn.addEventListener("click", () => {
  const blocked = !spacingOn && noPlanTargetMessage("인동거리");
  if (blocked) {
    setStatus(blocked);
    return;
  }
  spacingOn = !spacingOn;
  setToggle(spacingBtn, spacingOn);
  syncSetbackRules();
  updateSetbackChecks();
  setStatus(
    spacingOn
      ? "인동거리 검토 켬 — 회색=적합, 빨강=위반 (이동·회전 중 실시간 갱신)"
      : "인동거리 검토 끔",
  );
});

for (const el of [
  northLowInput,
  northRatioInput,
  daylightRatioInput,
  daylightRoadParkInput,
  spacingWindowInput,
  spacingNoWindowMInput,
  spacingSideMInput,
]) {
  el.addEventListener("change", () => {
    syncSetbackRules();
    updateSetbackChecks();
  });
}

// ---------- 일조권 검토 (수인한도 — 인접건물, 연속2h/총4h) ----------
// 정북사선(M2)과 완전히 별도 — 실제 태양 위치 레이캐스팅 기반 판정이라 PV(M4)와 계산량이
// 비슷해 버튼 실행 + 청크 비동기 처리를 쓴다(항상 자동 갱신하는 M3 패턴과 다름).

const sunHoursRoot = new THREE.Group();
viewer.scene.add(sunHoursRoot);

const sunHoursRuleSelect = document.getElementById("sunhours-rule") as HTMLSelectElement;
const sunHoursStepInput = document.getElementById("sunhours-step") as HTMLInputElement;
const runSunHoursBtn = document.getElementById("run-sunhours") as HTMLButtonElement;
const sunHoursRoadOnlyInput = document.getElementById("sunhours-road-only") as HTMLInputElement;
const sunHoursPassRatioInput = document.getElementById("sunhours-pass-ratio") as HTMLInputElement;

/** 일조권 설정 입력값 → project (실행·저장 공용) */
function syncSunHoursSettings(): void {
  const sh = project.analysis.sunHours;
  sh.rule = sunHoursRuleSelect.value as SunHoursRule;
  sh.timeStep = Math.max(5, parseFloat(sunHoursStepInput.value) || 10);
  sh.roadFacingOnly = sunHoursRoadOnlyInput.checked;
  const pct = parseFloat(sunHoursPassRatioInput.value);
  sh.passRatio = Math.min(100, Math.max(1, Number.isFinite(pct) ? pct : 50)) / 100;
}

runSunHoursBtn.addEventListener("click", async () => {
  if (sunHoursRunning) return;
  const adjCount = project.buildings.filter((b) => b.type === "인접건물").length;
  if (adjCount === 0) {
    setStatus("일조권 검토 대상(인접건물)이 없습니다. 먼저 DXF를 불러오세요.");
    return;
  }
  syncAnalysisSettings();
  syncSunHoursSettings();
  clearGroup(sunHoursRoot);
  lastSunHours = null;
  sunHoursRunning = true;
  runSunHoursBtn.disabled = true;
  setStatus("일조권 검토 중… 0%");
  try {
    const t0 = performance.now();
    const result = await runSunHoursCheck(project, (done, total) => {
      setStatus(`일조권 검토 중… ${Math.round((done / total) * 100)}%`);
    });
    lastSunHours = result;
    const ms = performance.now() - t0;
    sunHoursRoot.add(createSunHoursOverlay(result.cells, result.results));
    const passTotal = result.results.filter((r) => r.pass).length;
    const ruleLabel =
      result.rule === "continuous"
        ? "연속 2h(9~15시)"
        : result.rule === "total"
          ? "총 4h(8~16시)"
          : "연속2h 또는 총4h";
    const roadNote = project.analysis.sunHours.roadFacingOnly && !result.roadFacingOnly
      ? " · 도로(ROAD_AREA·ROAD_CL)가 없어 전체 벽·지붕으로 판정"
      : result.roadFacingOnly
        ? ` · 도로 접면 기준(${result.roadSource})`
        : "";
    renderSunHoursSummary(
      result.summaries,
      ruleLabel,
      `격자 ${result.cells.length}셀 × ${result.samples.length}시각 · ${(ms / 1000).toFixed(1)}초${roadNote}`,
      { passRatio: result.passRatio, roadFacingOnly: result.roadFacingOnly, excluded: result.excludedBuildings },
    );
    updateLegends();
    setStatus(
      `일조권 검토 완료 — 적합 ${passTotal} / ${result.cells.length}셀 (파랑=적합, 빨강=위반)`,
    );
    refreshStatusDots(computeStatusMap());
  } catch (err) {
    setStatus(`일조권 검토 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    sunHoursRunning = false;
    runSunHoursBtn.disabled = false;
  }
});

document.getElementById("clear-sunhours")!.addEventListener("click", () => {
  lastSunHours = null;
  clearGroup(sunHoursRoot);
  renderSunHoursSummary(null);
  updateLegends();
  refreshStatusDots(computeStatusMap());
  setStatus("일조권 검토 결과를 지웠습니다.");
});

// ---------- 교육·종교시설 창문 일조 (유치원·초등학교·교회) ----------
// 인접건물 중 용도를 지정한 동의 ADJ_WIN 창 × 교실 층마다 사업 전·후 일조시간을 비교한다.

const facilityHeightInput = document.getElementById("facility-height") as HTMLInputElement;
const facilityWindowSelect = document.getElementById("facility-window") as HTMLSelectElement;
const runFacilityBtn = document.getElementById("run-facility") as HTMLButtonElement;

function syncFacilitySettings(): void {
  const h = parseFloat(facilityHeightInput.value);
  project.analysis.facility = {
    windowHeightM: Math.min(3, Math.max(0, Number.isFinite(h) ? h : 1.2)),
    schoolContinuousWindow: facilityWindowSelect.value === "9-13" ? "9-13" : "9-15",
  };
}

for (const el of [facilityHeightInput, facilityWindowSelect]) {
  el.addEventListener("change", () => {
    syncFacilitySettings();
    if (lastFacility) clearFacility("설정이 바뀌어 결과가 초기화되었습니다. 다시 실행하세요.");
  });
}

runFacilityBtn.addEventListener("click", async () => {
  if (facilityRunning) return;
  const targets = project.buildings.filter((b) => b.type === "인접건물" && b.use);
  if (targets.length === 0) {
    setStatus("용도(유치원·초등학교·교회)를 지정한 인접건물이 없습니다 — 건물을 선택해 상세 패널에서 용도를 고르세요.");
    return;
  }
  syncAnalysisSettings();
  syncSunHoursSettings();
  syncFacilitySettings();
  clearFacility();
  facilityRunning = true;
  runFacilityBtn.disabled = true;
  setStatus("교육·종교시설 일조 검토 중… 0%");
  try {
    const t0 = performance.now();
    const r = await runFacilityCheck(project, (done, total) => {
      setStatus(`교육·종교시설 일조 검토 중… ${Math.round((done / total) * 100)}%`);
    });
    lastFacility = r;
    facilityGroup = createFacilityOverlay(r.points);
    viewer.scene.add(facilityGroup);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    renderFacilitySummary(r, `기준일 ${r.date} · ${r.timeStep}분 간격 · 측정점 ${r.points.length}개 · ${sec}초`);
    updateLegends();
    const affected = r.summaries.filter((s) => s.affected).length;
    setStatus(
      r.summaries.length === 0
        ? "검토할 창이 없습니다 — 시설 동에 ADJ_WIN 창 표시가 필요합니다."
        : `교육·종교시설 일조 검토 완료 — ${r.summaries.length}동 중 사업 영향 ${affected}동 ` +
          `(파랑=확보, 빨강=사업으로 미달, 주황=기존 미달·추가 감소, 회색=기존 미달)`,
    );
    refreshStatusDots(computeStatusMap());
  } catch (err) {
    setStatus(`교육·종교시설 일조 검토 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    facilityRunning = false;
    runFacilityBtn.disabled = false;
  }
});

document.getElementById("clear-facility")!.addEventListener("click", () => {
  clearFacility();
  refreshStatusDots(computeStatusMap());
  setStatus("교육·종교시설 일조 결과를 지웠습니다.");
});

// ---------- 바람길 분석 (M8) ----------
// EPW 풍향·풍속 통계(주풍향) + 2D 포텐셜 흐름 근사 — CFD가 아닌 개략 검토.
// 속도장·스트림라인은 결정적 계산이라 즉시 완료되지만, 배치가 바뀌면 무효화된다.

/** 현재 표시 중인 스트림라인 그룹 — createWindOverlay가 scene에 직접 추가한다 */
let windGroup: THREE.Group | null = null;

function clearWindOverlay(): void {
  if (windGroup) {
    disposeWindOverlay(windGroup);
    windGroup = null;
  }
}

const windEpwSelect = document.getElementById("wind-epw") as HTMLSelectElement;
for (const { file, label } of EPW_FILES) {
  const opt = document.createElement("option");
  opt.value = file;
  opt.textContent = label;
  windEpwSelect.appendChild(opt);
}
const windMonthSelect = document.getElementById("wind-month") as HTMLSelectElement;
const windRefHeightInput = document.getElementById("wind-ref-height") as HTMLInputElement;
const runWindBtn = document.getElementById("run-wind") as HTMLButtonElement;

/** 파일별 풍향통계 캐시 — M5 EPW 캐시(일사 전용)와 별개로 원문에서 풍향·풍속만 뽑는다 */
const windRoseCache = new Map<string, WindRoseData>();

async function loadWindRose(file: string): Promise<WindRoseData> {
  const cached = windRoseCache.get(file);
  if (cached) return cached;
  const res = await fetch(`/data/${file}`);
  if (!res.ok) throw new Error(`EPW 파일을 불러올 수 없습니다: ${file}`);
  const rose = computeWindRose(await res.text());
  windRoseCache.set(file, rose);
  return rose;
}

/** 바람길 분석용 속도장 격자 간격 (m) */
const WIND_GRID_M = 2;
const WIND_SEED_COUNT = 90;

runWindBtn.addEventListener("click", async () => {
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  runWindBtn.disabled = true;
  const label = windEpwSelect.selectedOptions[0]?.textContent ?? windEpwSelect.value;
  try {
    setStatus(`바람길 분석 — ${label} EPW 풍향통계 불러오는 중…`);
    const rose = await loadWindRose(windEpwSelect.value);
    const month = windMonthSelect.value ? parseInt(windMonthSelect.value, 10) : null;
    const stats = month === null ? rose.annual : rose.monthly[month - 1];
    if (stats.hours === 0) throw new Error("선택한 기간에 유효한 풍향 데이터가 없습니다");

    clearWindOverlay();
    setStatus("바람길 계산 중… (백그라운드)");
    const refH = Math.max(0, parseFloat(windRefHeightInput.value) || 0);
    const done = await new Promise<WindDoneMessage>((resolve, reject) => {
      const w = new Worker(new URL("./wind.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<WindDoneMessage>) => {
        w.terminate();
        resolve(ev.data);
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message));
      };
      w.postMessage({
        buildings: project.buildings,
        site: project.site,
        windDirDeg: stats.prevailingDirDeg,
        gridM: WIND_GRID_M,
        refHeightM: refH,
        lineCount: WIND_SEED_COUNT,
      } satisfies WindRunMessage);
    });
    lastWind = {
      windDir: stats.prevailingDirDeg,
      windSpeedMs: stats.meanSpeedMs,
      month,
      streamlines: done.streamlines,
      shadowAreaM2: done.shadowAreaM2,
    };
    windGroup = createWindOverlay(lastWind, viewer.scene, terrainSampler());
    renderWindSummary(
      lastWind,
      `${label} EPW ${stats.hours}시간 통계 · 격자 ${WIND_GRID_M}m · ` +
        (refH > 0 ? `2.5D(${refH}m 미만 건물은 높이 비례 통과)` : "순수 2D") +
        ` · 포텐셜 근사(CFD 아님)`,
    );
    updateLegends();
    setStatus(
      `바람길 분석 완료 — ${month === null ? "연간" : `${month}월`} 주풍향 ` +
        `${windDirLabel(lastWind.windDir)}(${lastWind.windDir.toFixed(0)}°) ` +
        `${lastWind.windSpeedMs.toFixed(1)}m/s · 바람그림자 ${lastWind.shadowAreaM2.toFixed(0)}㎡`,
    );
  } catch (err) {
    setStatus(`바람길 분석 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    runWindBtn.disabled = false;
  }
});

document.getElementById("clear-wind")!.addEventListener("click", () => {
  lastWind = null;
  clearWindOverlay();
  renderWindSummary(null);
  updateLegends();
  setStatus("바람길 결과를 지웠습니다.");
});

// ---------- LBM 정밀 시뮬레이션 (M10) ----------
// D2Q9 격자 볼츠만 — M8 포텐셜 근사와 별개 모드(둘 다 유지). 도메인은 메인에서
// 만들고 WebWorker가 수렴까지 스텝을 돌리며, 25스텝마다 속도비를 transferable로
// 받아 히트맵을 실시간 갱신한다. 유선은 M8 createWindOverlay를 재사용.

let lbmWorker: Worker | null = null;
let lbmHeatmap: LbmHeatmap | null = null;
let lbmStreamGroup: THREE.Group | null = null;

const lbmDirModeSelect = document.getElementById("lbm-dir-mode") as HTMLSelectElement;
const lbmDirManualRow = document.getElementById("lbm-dir-manual-row") as HTMLElement;
const lbmDirDegInput = document.getElementById("lbm-dir-deg") as HTMLInputElement;
const lbmSpeedInput = document.getElementById("lbm-speed") as HTMLInputElement;
const lbmGridSelect = document.getElementById("lbm-grid") as HTMLSelectElement;
const lbmHeatmapChk = document.getElementById("lbm-heatmap") as HTMLInputElement;
const lbmStreamChk = document.getElementById("lbm-streamlines") as HTMLInputElement;
const runLbmBtn = document.getElementById("run-lbm") as HTMLButtonElement;

lbmDirModeSelect.addEventListener("change", () => {
  lbmDirManualRow.hidden = lbmDirModeSelect.value !== "manual";
});

lbmHeatmapChk.addEventListener("change", () => {
  if (lbmHeatmap) lbmHeatmap.mesh.visible = lbmHeatmapChk.checked;
  updateLegends();
});
lbmStreamChk.addEventListener("change", () => {
  if (lbmStreamGroup) lbmStreamGroup.visible = lbmStreamChk.checked;
  updateLegends();
});

function clearLbmOverlays(): void {
  if (lbmHeatmap) {
    lbmHeatmap.dispose();
    lbmHeatmap = null;
  }
  if (lbmStreamGroup) {
    disposeWindOverlay(lbmStreamGroup);
    lbmStreamGroup = null;
  }
}

/** 실행 중이면 워커까지 강제 종료 — 배치 변경 무효화·지우기 공용 */
function resetLbm(note?: string): void {
  if (lbmWorker) {
    lbmWorker.terminate();
    lbmWorker = null;
  }
  runLbmBtn.textContent = "LBM 정밀 시뮬레이션";
  lastLbm = null;
  clearLbmOverlays();
  renderLbmSummary(null, note);
  updateLegends();
}

runLbmBtn.addEventListener("click", async () => {
  if (lbmWorker) {
    // 실행 중 — 부드러운 중지 요청 (워커가 현재 상태로 done을 보낸다)
    lbmWorker.postMessage({ type: "stop" } satisfies LbmStopMessage);
    setStatus("LBM 중지 요청 — 현재 스텝까지의 결과를 정리합니다…");
    return;
  }
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  try {
    // 풍향 — EPW 주풍향(자동, M8의 기상데이터·기간 선택 공유) 또는 수동 입력
    let windDir: number;
    let dirSource: "epw" | "manual";
    if (lbmDirModeSelect.value === "manual") {
      windDir = ((parseFloat(lbmDirDegInput.value) || 0) % 360 + 360) % 360;
      dirSource = "manual";
    } else {
      setStatus("LBM — EPW 풍향통계 불러오는 중…");
      const rose = await loadWindRose(windEpwSelect.value);
      const month = windMonthSelect.value ? parseInt(windMonthSelect.value, 10) : null;
      const stats = month === null ? rose.annual : rose.monthly[month - 1];
      if (stats.hours === 0) throw new Error("선택한 기간에 유효한 풍향 데이터가 없습니다");
      windDir = stats.prevailingDirDeg;
      dirSource = "epw";
    }
    const windSpeed = Math.max(0.5, parseFloat(lbmSpeedInput.value) || 3.1);
    const gridM =
      lbmGridSelect.value === "auto"
        ? chooseLbmGridM(project.buildings, project.site, windDir)
        : parseInt(lbmGridSelect.value, 10);

    const refH = Math.max(0, parseFloat(windRefHeightInput.value) || 0);
    const domain = buildLbmDomain(project.buildings, project.site, windDir, gridM, refH);
    resetLbm();
    // 지형이 있으면 히트맵을 지형 표면에 드레이프 — 없으면 평지(y=0.2)
    lbmHeatmap = createLbmHeatmap(domain, terrainSampler());
    lbmHeatmap.mesh.visible = lbmHeatmapChk.checked;
    viewer.scene.add(lbmHeatmap.mesh);

    const worker = new Worker(new URL("./lbm.worker.ts", import.meta.url), {
      type: "module",
    });
    lbmWorker = worker;
    runLbmBtn.textContent = "중지";
    setStatus(
      `LBM 시뮬레이션 시작 — 풍향 ${windDirLabel(windDir)}(${windDir.toFixed(0)}°) · ` +
        `격자 ${gridM}m (${domain.nx}×${domain.ny})`,
    );

    worker.onmessage = (ev: MessageEvent<LbmProgressMessage | LbmDoneMessage>) => {
      const msg = ev.data;
      if (msg.type === "progress") {
        lbmHeatmap?.update(msg.ratio);
        const pct = Math.min(99, Math.round((msg.step / LBM_MAX_STEPS) * 100));
        setStatus(
          `LBM 시뮬레이션 중… ${pct}% — ${msg.step}스텝, 잔차 ${(msg.residual * 100).toFixed(2)}% (목표 <0.1%)`,
        );
        return;
      }
      // done — 지표·유선까지 조립하고 워커 정리
      worker.terminate();
      lbmWorker = null;
      runLbmBtn.textContent = "LBM 정밀 시뮬레이션";
      const result = assembleLbmResult(domain, msg.ux, msg.uy, project.buildings, {
        windDirDeg: windDir,
        windDirSource: dirSource,
        windSpeedMs: windSpeed,
        steps: msg.steps,
        converged: msg.converged,
      });
      lastLbm = result;
      lbmHeatmap?.update(result.ratio);
      lbmStreamGroup = createWindOverlay(
        {
          windDir,
          windSpeedMs: windSpeed,
          month: null,
          streamlines: result.streamlines,
          shadowAreaM2: result.shadowAreaM2,
        },
        viewer.scene,
        terrainSampler(),
      );
      lbmStreamGroup.name = "lbm-streamlines";
      lbmStreamGroup.visible = lbmStreamChk.checked;
      renderLbmSummary(
        result,
        `D2Q9 · 격자 ${gridM}m · ${dirSource === "epw" ? "EPW 주풍향" : "수동 풍향"} · ` +
          (refH > 0 ? `2.5D(${refH}m 미만 건물 다공성 통과)` : "순수 2D") +
          ` — CFD 상세 대체 아님`,
      );
      updateLegends();
      const gain = ((result.maxRatio - 1) * 100).toFixed(0);
      setStatus(
        msg.converged
          ? `LBM 수렴 완료 (${msg.steps}스텝) — 최대 증가율 +${gain}% · 바람 그늘 ${result.shadowAreaM2.toFixed(0)}㎡`
          : `LBM ${msg.stopped ? "중지됨" : "미수렴"} (${msg.steps}스텝) — 결과는 참고용`,
      );
    };
    worker.onerror = (e) => {
      resetLbm();
      setStatus(`LBM 워커 오류: ${e.message}`);
    };
    // solid 마스크는 복사 전송(transfer 아님) — 메인 스레드가 히트맵에 계속 쓴다
    worker.postMessage({ type: "run", domain } satisfies LbmRunMessage);
  } catch (err) {
    resetLbm();
    setStatus(`LBM 실패: ${(err as Error).message}`);
    console.error(err);
  }
});

document.getElementById("clear-lbm")!.addEventListener("click", () => {
  resetLbm();
  setStatus("LBM 결과를 지웠습니다.");
});

// ---------- 일조시간 지도 (M9) ----------
// 지면+계획주동 표면의 직달일조 시간 히트맵 — 일조권 검토(M2.1, 인접건물 수인한도
// 판정)와 별개의 시각화 도구. 레이캐스팅이라 버튼 실행 + 청크 비동기(M5 패턴).

/** 현재 표시 중인 히트맵 그룹 */
let sunHoursMapGroup: THREE.Group | null = null;

function clearSunHoursMapOverlay(): void {
  if (sunHoursMapGroup) {
    disposeSunHoursMapOverlay(sunHoursMapGroup);
    sunHoursMapGroup = null;
  }
}

const sunMapDateSelect = document.getElementById("sunhoursmap-date") as HTMLSelectElement;
const sunMapLegalCheckbox = document.getElementById("sunhoursmap-legal") as HTMLInputElement;
const runSunMapBtn = document.getElementById("run-sunhoursmap") as HTMLButtonElement;

function showSunHoursMapOverlay(): void {
  clearSunHoursMapOverlay();
  if (!lastSunHoursMap) return;
  sunHoursMapGroup = createSunHoursMapOverlay(
    lastSunHoursMap,
    sunMapLegalCheckbox.checked,
    terrainVisible ? drapeSurface() : undefined,
  );
  viewer.scene.add(sunHoursMapGroup);
}

runSunMapBtn.addEventListener("click", async () => {
  if (sunHoursMapRunning) return;
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  syncAnalysisSettings();
  clearSunHoursMapOverlay();
  lastSunHoursMap = null;
  sunHoursMapRunning = true;
  runSunMapBtn.disabled = true;
  setStatus("일조시간 분석 중… 0%");
  try {
    const date = sunMapDateSelect.value as SunHoursDate;
    const t0 = performance.now();
    const result = await runSunHoursMap(project, date, (done, total) => {
      setStatus(`일조시간 분석 중… ${Math.round((done / total) * 100)}%`);
    });
    lastSunHoursMap = result;
    const ms = performance.now() - t0;
    showSunHoursMapOverlay();
    renderSunHoursMapSummary(
      result,
      `격자 2m × ${result.dates.length}일 × 17시각 · ${(ms / 1000).toFixed(1)}초`,
    );
    updateLegends();
    setStatus(
      `일조시간 분석 완료(${date}) — ${result.cells.length}셀 · ` +
        `평균 ${result.stats.avg.toFixed(1)}h` +
        (result.groundAvg !== null ? ` · 지면평균 ${result.groundAvg.toFixed(1)}h` : "") +
        ` (0h=암청 → 8h=노랑)`,
    );
  } catch (err) {
    setStatus(`일조시간 분석 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    sunHoursMapRunning = false;
    runSunMapBtn.disabled = false;
  }
});

// 법적기준 오버레이 토글 — 재계산 없이 기존 결과의 색상만 다시 그린다
sunMapLegalCheckbox.addEventListener("change", () => {
  if (!lastSunHoursMap) return;
  showSunHoursMapOverlay();
  updateLegends();
  setStatus(
    sunMapLegalCheckbox.checked
      ? "일조시간 법적기준 오버레이 — 파랑=연속2h 또는 총4h 충족, 빨강=미달 (참고용)"
      : "일조시간 히트맵 — 0h=암청 → 8h=노랑",
  );
});

document.getElementById("clear-sunhoursmap")!.addEventListener("click", () => {
  lastSunHoursMap = null;
  clearSunHoursMapOverlay();
  renderSunHoursMapSummary(null);
  updateLegends();
  setStatus("일조시간 결과를 지웠습니다.");
});

// ---------- 세대수·엑셀 내보내기 (M6) ----------
// 주동 타입 템플릿 추가는 건물 라이브러리 패널(기본 샘플 템플릿)로 통합됨.

const siteAreaInput = document.getElementById("site-area") as HTMLInputElement;

/** 사이드 패널 하단 세대수 합계 + 건폐율·용적률 갱신 */
function updateSiteTotals(): void {
  project.site.siteAreaM2 = Math.max(0, parseFloat(siteAreaInput.value) || 0);
  syncGfaExtra();
  renderSiteTotals(project.buildings, project.site.siteAreaM2, project.analysis.gfaExtra);
}

const gfaRetailInput = document.getElementById("gfa-retail") as HTMLInputElement;
const gfaAmenityInput = document.getElementById("gfa-amenity") as HTMLInputElement;
/** 근생·부대 입력값 → project (용적률 표시·엑셀·보고서·자동 배분 공용) */
function syncGfaExtra(): void {
  project.analysis.gfaExtra = {
    retailM2: Math.max(0, parseFloat(gfaRetailInput.value) || 0),
    amenityPerUnit: Math.max(0, parseFloat(gfaAmenityInput.value) || 0),
  };
}
for (const el of [gfaRetailInput, gfaAmenityInput]) {
  el.addEventListener("change", () => {
    updateSiteTotals();
    commitHistory();
  });
}

siteAreaInput.addEventListener("change", () => {
  updateSiteTotals();
  commitHistory();
});

document.getElementById("export-xlsx")!.addEventListener("click", async () => {
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오거나 주동을 추가하세요.");
    return;
  }
  updateSiteTotals();
  try {
    // 엑셀 라이브러리(xlsx-js-style)는 400KB대라 초기 로드에 포함하지 않고
    // 내보내기를 누른 시점에만 받아온다 — 태블릿 첫 진입 속도에 크게 영향
    setStatus("엑셀 모듈 불러오는 중…");
    const { buildXlsxBlob, xlsxFilename, XLSX_MIME } = await import("./excel");
    const blob = buildXlsxBlob(
      project,
      lastSunHours,
      lastNorthSetback,
      null,
      null,
      lastWind,
      lastSunHoursMap,
      lastLbm,
      lastFacility,
      analysisSheets(),
    );
    const filename = xlsxFilename();
    const outcome = await shareOrDownload(
      new File([blob], filename, { type: XLSX_MIME }),
      "arch_view 배치검토",
    );
    if (outcome === "cancelled") {
      setStatus("공유 취소됨");
      return;
    }
    const t = siteUnitTotals(project.buildings);
    setStatus(
      `엑셀 ${outcome === "shared" ? "공유함" : "내보냄"} — ${filename} ` +
        `(배치 개요 · 일조권 · 정북사선 · PV · 바람길 · LBM · 일조시간, 총 ${t.total}세대)`,
    );
  } catch (err) {
    setStatus(`엑셀 내보내기 실패: ${(err as Error).message}`);
    console.error(err);
  }
});

// ---------- DXF 배치도 내보내기 / .view 프로젝트 저장·불러오기 ----------

document.getElementById("export-dxf")!.addEventListener("click", async () => {
  if (!hasExportContent(project)) {
    setStatus("내보낼 배치가 없습니다 — 먼저 DXF를 불러오거나 주동을 배치하세요.");
    return;
  }
  // 마지막으로 고른 표준 시점으로 내보낸다 — 평면은 기존 라운드트립 경로 그대로,
  // 입면·아이소는 1:1 정투영/등각투영
  const view = exportView;
  const viewLabel = DXF_VIEW_LABEL[view];
  const text = buildDxfTextForView(project, sceneOrigin, view);
  const suffix = view === "top" ? "배치도" : viewLabel.replace(/\s/g, "");
  const filename = `arch_view_${suffix}_${new Date().toISOString().slice(0, 10)}.dxf`;
  const outcome = await shareOrDownloadText(
    text,
    filename,
    "application/dxf",
    `arch_view ${viewLabel}`,
  );
  if (outcome === "cancelled") {
    setStatus("공유 취소됨");
    return;
  }
  const plan = project.buildings.filter((b) => b.type === "계획주동").length;
  const adj = project.buildings.length - plan;
  setStatus(
    `DXF ${outcome === "shared" ? "공유함" : "내보냄"}(${viewLabel}) — ${filename} ` +
      `(계획주동 ${plan}동 · 인접건물 ${adj}동 · ` +
      `오버레이 ${project.siteOverlays.length}개, mm 단위 R12 · 축척 1:1)`,
  );
});

/** 현재 UI 입력값(위치·격자·사선 기준·일조권 설정·대지면적)을 project에 반영 */
function syncAllSettings(): void {
  syncAnalysisSettings();
  syncSetbackRules();
  syncSunHoursSettings();
  project.site.siteAreaM2 = Math.max(0, parseFloat(siteAreaInput.value) || 0);
}

/**
 * 현재 프로젝트를 .view로 저장(또는 공유). "새로 시작하기"의 저장 단계도 같은 경로를 탄다.
 * @returns 저장/공유가 끝났으면 true — 사용자가 공유 시트를 닫았거나 실패하면 false
 *   (초기화처럼 되돌릴 수 없는 동작 앞에서는 이 결과를 반드시 확인해야 한다)
 */
async function saveProjectFile(): Promise<boolean> {
  syncAllSettings();
  const json = serializeView(project, sceneOrigin, { dxfLoadSeq, sceneSeq });
  const filename = `arch_view_${new Date().toISOString().slice(0, 10)}.view`;
  try {
    // 데스크톱 Chrome·Edge: 바탕화면이 열린 저장 창 — 저장 위치를 사용자가 확인한다
    const picked = await saveToDesktop(
      new Blob([json], { type: "application/json" }),
      filename,
      "arch_view 프로젝트",
      { "application/json": [".view"] },
    );
    if (picked === "cancelled") {
      setStatus("저장 취소됨");
      return false;
    }
    if (picked !== "unsupported") {
      setStatus(
        `프로젝트 저장 — ${picked} (장면 ${project.buildings.length}동 · ` +
          `라이브러리 ${project.buildingLibrary.length}동 · 분석 설정 포함)`,
      );
      return true;
    }
    const outcome = await shareOrDownloadText(
      json,
      filename,
      "application/json",
      "arch_view 프로젝트",
    );
    if (outcome === "cancelled") {
      setStatus("공유 취소됨");
      return false;
    }
    setStatus(
      `프로젝트 ${outcome === "shared" ? "공유함" : "저장"} — ${filename} ` +
        `(장면 ${project.buildings.length}동 · ` +
        `라이브러리 ${project.buildingLibrary.length}동 · 분석 설정 포함)`,
    );
    return true;
  } catch (err) {
    setStatus(`프로젝트 저장 실패: ${(err as Error).message}`);
    console.error(err);
    return false;
  }
}

document.getElementById("save-view")!.addEventListener("click", () => {
  void saveProjectFile();
});

/** .view에서 복원한 project 값을 UI 입력창에 되반영 */
function applyProjectToInputs(): void {
  latInput.value = String(project.site.latitude);
  lngInput.value = String(project.site.longitude);
  dateInput.value = project.analysis.date;
  gridInput.value = String(project.analysis.gridSize);
  siteAreaInput.value = String(project.site.siteAreaM2);
  gfaRetailInput.value = String(project.analysis.gfaExtra?.retailM2 ?? 0);
  gfaAmenityInput.value = String(project.analysis.gfaExtra?.amenityPerUnit ?? 0);
  fillSetbackInputs(project.analysis.setbackRules);
  sunHoursRuleSelect.value = project.analysis.sunHours.rule;
  sunHoursStepInput.value = String(project.analysis.sunHours.timeStep);
  sunHoursRoadOnlyInput.checked = project.analysis.sunHours.roadFacingOnly ?? true;
  sunHoursPassRatioInput.value = String(Math.round((project.analysis.sunHours.passRatio ?? 0.5) * 100));
  const fac = project.analysis.facility ?? defaultFacilitySettings();
  facilityHeightInput.value = String(fac.windowHeightM);
  facilityWindowSelect.value = fac.schoolContinuousWindow;
}

/**
 * .view 데이터를 현재 프로젝트에 적용하고 장면을 다시 만든다.
 * 파일(.view 열기)과 저장된 배치안 불러오기가 같은 경로를 타도록 분리해 둔 함수 —
 * 한쪽만 고쳐서 복원 결과가 갈라지는 일을 막는다.
 */
function applyViewData(d: ViewFileData): void {
  project.site = d.site;
  project.analysis = d.analysis;
  project.buildings = d.buildings;
  project.buildingLibrary = d.buildingLibrary;
  project.siteOverlays = d.siteOverlays;
  project.terrainPoints = d.terrainPoints;
  if (d.savedViews) project.savedViews = d.savedViews;
  project.canopies = d.canopies ?? [];
  project.trees = d.trees ?? [];
  renderSavedViews();
  sceneOrigin = d.sceneOrigin;
  // id 카운터는 이어서 발급 — 복원된 건물과 새 건물의 id 충돌 방지
  dxfLoadSeq = Math.max(dxfLoadSeq, d.counters.dxfLoadSeq);
  sceneSeq = Math.max(sceneSeq, d.counters.sceneSeq);
  cloneOrigin.clear();
  libraryCheckedIds.clear();
  for (const b of project.buildingLibrary) libraryCheckedIds.add(b.id);
  selectedId = null;

  applyProjectToInputs();
  rebuildTerrain(); // rebuildAll보다 먼저 — 건물 G.L. 계산이 terrainModel을 참조
  rebuildAll();
  rebuildOverlays();
  viewer.fitToBuildings();
  refreshList();
  refreshLibraryList();
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  updateSunFromSlider();
  resetHistory();
  notifyProjectLoaded();
}

// ---------- 새로 시작하기 (초기화) ----------

const resetModal = document.getElementById("reset-modal") as HTMLElement;

/** 초기화하면 사라지는 것이 있는가 — 빈 화면이면 확인 없이 바로 초기화한다 */
function hasWorkInProgress(): boolean {
  return (
    project.buildings.length > 0 ||
    project.buildingLibrary.length > 0 ||
    project.siteOverlays.length > 0 ||
    project.terrainPoints.length > 0
  );
}

/**
 * 빈 프로젝트로 되돌린다. 복원 경로(applyViewData)를 그대로 재사용해
 * "불러오기로 빈 프로젝트를 연 것"과 같은 상태가 되게 한다 —
 * 장면·오버레이·지형·분석 결과·선택 상태가 한 곳에서 정리된다.
 */
function resetProject(): void {
  const empty = defaultProject();
  applyViewData({
    format: VIEW_FORMAT,
    version: VIEW_VERSION,
    savedAt: "",
    sceneOrigin: null,
    // 카운터는 이어서 발급 — 초기화 후 새 건물이 이전 id와 겹치지 않게
    counters: { dxfLoadSeq, sceneSeq },
    site: empty.site,
    analysis: empty.analysis,
    buildings: [],
    buildingLibrary: [],
    siteOverlays: [],
    terrainPoints: [],
    savedViews: [],
    canopies: [],
    trees: [],
  });
  setStatus("새로 시작 — 화면이 초기화되었습니다. DXF 파일을 불러오세요.");
}

document.getElementById("new-project")!.addEventListener("click", () => {
  if (!hasWorkInProgress()) {
    resetProject();
    return;
  }
  const t = siteUnitTotals(project.buildings);
  const summary = document.getElementById("reset-summary");
  if (summary) {
    summary.textContent =
      `현재 작업: 장면 ${project.buildings.length}동` +
      (t.total > 0 ? ` · ${t.total}세대` : "") +
      ` · 라이브러리 ${project.buildingLibrary.length}동` +
      (project.siteOverlays.length > 0 ? ` · 오버레이 ${project.siteOverlays.length}개` : "") +
      (project.terrainPoints.length > 0 ? " · 지형 있음" : "");
  }
  resetModal.hidden = false;
});

document.getElementById("reset-cancel")!.addEventListener("click", () => {
  resetModal.hidden = true;
});

resetModal.addEventListener("click", (e) => {
  if (e.target === resetModal) resetModal.hidden = true;
});

document.getElementById("reset-discard")!.addEventListener("click", () => {
  resetModal.hidden = true;
  resetProject();
});

document.getElementById("reset-save-first")!.addEventListener("click", async () => {
  // 저장이 끝난(또는 공유 시트를 닫은) 뒤에만 초기화 — 저장 실패로 작업을 잃지 않게
  const saved = await saveProjectFile();
  if (!saved) {
    setStatus("저장하지 못해 초기화를 중단했습니다 — 작업은 그대로입니다.");
    return;
  }
  resetModal.hidden = true;
  resetProject();
});

document.getElementById("view-file")!.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const d = deserializeView(await file.text());
    applyViewData(d);
    const saved = d.savedAt ? ` (저장 시각 ${d.savedAt.slice(0, 16).replace("T", " ")})` : "";
    const terrainInfo = terrainModel
      ? ` · 지형 로드됨 (고도 범위: ${terrainModel.minZ.toFixed(1)}m ~ ${terrainModel.maxZ.toFixed(1)}m)`
      : "";
    setStatus(
      `${file.name} 불러옴 — 장면 ${project.buildings.length}동 · ` +
        `라이브러리 ${project.buildingLibrary.length}동 · 오버레이 ${project.siteOverlays.length}개${terrainInfo}${saved}`,
    );
  } catch (err) {
    setStatus(`.view 불러오기 실패: ${(err as Error).message}`);
    console.error(err);
  }
  input.value = "";
});

// ---------- 시간 슬라이더 — 태양 위치·그림자 미리보기 ----------

const timeSlider = document.getElementById("time-slider") as HTMLInputElement;
const timeLabel = document.getElementById("time-label")!;
const sunLabel = document.getElementById("sun-label")!;

function updateSunFromSlider(): void {
  const minutes = parseInt(timeSlider.value, 10);
  timeLabel.textContent = formatMinutes(minutes);
  const pos = sunPosition(
    localDate(project.analysis.date, minutes),
    project.site.latitude,
    project.site.longitude,
    project.site.northAngle,
  );
  viewer.setSun(pos.dir);
  sunLabel.textContent = pos.dir
    ? `고도 ${pos.altitudeDeg.toFixed(1)}° · 방위 ${pos.azimuthDeg.toFixed(1)}°`
    : "태양이 지평선 아래";
}

timeSlider.addEventListener("input", updateSunFromSlider);

// ---------- 계획주동 드래그 이동 / 회전 핸들 ----------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const HANDLE_COLOR = 0xf5a623;

/** 선택된 계획주동의 회전 핸들 (링 + 그립 구슬) */
const handleGroup = new THREE.Group();
handleGroup.visible = false;
viewer.scene.add(handleGroup);

const handleRing = new THREE.LineLoop(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: HANDLE_COLOR }),
);
const handleGrip = new THREE.Mesh(
  new THREE.SphereGeometry(1.4, 16, 12),
  new THREE.MeshBasicMaterial({ color: HANDLE_COLOR }),
);
handleGroup.add(handleRing, handleGrip);

let handleRadius = 10;

function selectedPlanBuilding(): Building | null {
  const b = project.buildings.find((bb) => bb.id === selectedId);
  return b && b.type === "계획주동" ? b : null;
}

/** 건물 중심 (three 월드 좌표 XZ) */
function buildingCenter(b: Building): { x: number; z: number } {
  const c = footprintCentroid(b.footprint);
  return { x: c.x + b.offset.dx, z: -(c.y + b.offset.dy) };
}

function updateRotationHandle(): void {
  const b = planLocked ? null : selectedPlanBuilding();
  if (!b) {
    handleGroup.visible = false;
    return;
  }
  // 링 반경 = footprint 최대 반경 + 3m (반경은 회전 불변 — 원본 좌표로 계산)
  const c = footprintCentroid(b.footprint);
  let r = 0;
  for (const p of b.footprint) {
    r = Math.max(r, Math.hypot(p.x - c.x, p.y - c.y));
  }
  handleRadius = r + 3;

  const seg = 96;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(
      new THREE.Vector3(
        Math.cos(a) * handleRadius,
        0,
        Math.sin(a) * handleRadius,
      ),
    );
  }
  handleRing.geometry.dispose();
  handleRing.geometry = new THREE.BufferGeometry().setFromPoints(pts);

  const ctr = buildingCenter(b);
  handleGroup.position.set(ctr.x, 0.3, ctr.z);
  // 그립 위치: 회전각(DXF 반시계) 방향 — +X(동)에서 시작
  const phi = THREE.MathUtils.degToRad(b.offset.rotation);
  handleGrip.position.set(
    Math.cos(phi) * handleRadius,
    0,
    -Math.sin(phi) * handleRadius, // DXF y+ → three -z
  );
  handleGroup.visible = true;
}

interface DragState {
  building: Building;
  group: THREE.Group;
  startHit: THREE.Vector3;
  startOffset: { dx: number; dy: number };
  /** 탭 임계값을 넘어 실제로 끌었는지 — false면 클릭/탭이므로 배치를 건드리지 않는다 */
  moved: boolean;
}
interface RotateState {
  building: Building;
  group: THREE.Group;
  /** 직전 포인터 각도 (라디안, DXF 평면) */
  lastAngle: number;
  /** DragState.moved와 동일한 의미 */
  moved: boolean;
}

/** pointerdown 지점에서 탭 임계값을 넘어 움직였는가 (= 드래그로 볼 것인가) */
function pastTapSlop(e: PointerEvent): boolean {
  return isDrag(e.pointerType, downPos, { x: e.clientX, y: e.clientY });
}
let drag: DragState | null = null;
let rotate: RotateState | null = null;
let downPos: { x: number; y: number } | null = null;

const canvas = viewer.renderer.domElement;
/** 캔버스 좌하단 — 마우스 위치의 지면 좌표(DXF 평면, m) 표시 */
const cursorCoordsEl = document.getElementById("cursor-coords");

function setPointerFromEvent(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickBuilding(e: PointerEvent): THREE.Group | null {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, viewer.camera);
  const hits = raycaster.intersectObjects(viewer.buildingsRoot.children, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj && !obj.userData.buildingId) obj = obj.parent;
    if (obj) return obj as THREE.Group;
  }
  return null;
}

function pickHandleGrip(e: PointerEvent): boolean {
  if (!handleGroup.visible) return false;
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, viewer.camera);
  return raycaster.intersectObject(handleGrip, false).length > 0;
}

function groundHit(e: PointerEvent): THREE.Vector3 | null {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, viewer.camera);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, out) ? out : null;
}

/** 지형(보이면)·바닥 위 클릭 지점 → 도면 좌표 */
function terrainPoint(e: PointerEvent): { x: number; y: number } | null {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, viewer.camera);
  if (terrainVisible && viewer.terrainRoot.children.length) {
    const hits = raycaster
      .intersectObject(viewer.terrainRoot, true)
      .filter((h) => {
        if (!(h.object as THREE.Mesh).isMesh) return false;
        for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (!o.visible) return false;
        return true;
      });
    if (hits.length) return { x: hits[0].point.x, y: -hits[0].point.z };
  }
  const g = groundHit(e);
  return g ? { x: g.x, y: -g.z } : null;
}

/** 지면 점 찍기 모드 — 추가 분석(차양 배치 등)이 요청 */
let groundPick: {
  need: number;
  pts: { x: number; y: number }[];
  onPoint?: (p: { x: number; y: number }, i: number) => void;
  resolve: (pts: { x: number; y: number }[] | null) => void;
} | null = null;
const pickMarkers: THREE.Mesh[] = [];

function clearPickMarkers(): void {
  for (const m of pickMarkers) {
    viewer.scene.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  pickMarkers.length = 0;
}

function pickGroundPoints(
  n: number,
  prompt: string,
  onPoint?: (p: { x: number; y: number }, i: number) => void,
): Promise<{ x: number; y: number }[] | null> {
  if (groundPick) groundPick.resolve(null);
  clearPickMarkers();
  canvas.style.cursor = "crosshair";
  setStatus(`${prompt} (Esc로 취소)`);
  return new Promise((resolve) => {
    groundPick = {
      need: n,
      pts: [],
      onPoint,
      resolve: (pts) => {
        groundPick = null;
        canvas.style.cursor = "";
        clearPickMarkers();
        resolve(pts);
      },
    };
  });
}

/** 포인터의 건물 중심 기준 각도 (라디안, DXF 평면 반시계) */
function pointerAngle(b: Building, hit: THREE.Vector3): number {
  const ctr = buildingCenter(b);
  // three z → DXF y 부호 반전
  return Math.atan2(-(hit.z - ctr.z), hit.x - ctr.x);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };
  if (groundPick) return; // 점 찍기 중 — 건물 이동·회전 대신 화면 회전만

  // 1) 회전 그립 우선
  const planB = selectedPlanBuilding();
  if (planB && pickHandleGrip(e)) {
    const hit = groundHit(e);
    if (hit) {
      rotate = {
        building: planB,
        group: groups.get(planB.id)!,
        lastAngle: pointerAngle(planB, hit),
        moved: false,
      };
      viewer.controls.enabled = false;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      return;
    }
  }

  // 2) 건물 드래그 이동
  const group = pickBuilding(e);
  if (!group) return;
  const b = project.buildings.find(
    (bb) => bb.id === group.userData.buildingId,
  );
  if (!b || b.type !== "계획주동" || planLocked) return;
  const hit = groundHit(e);
  if (!hit) return;
  drag = {
    building: b,
    group,
    startHit: hit,
    startOffset: { ...b.offset },
    moved: false,
  };
  viewer.controls.enabled = false;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* 합성 이벤트 등 캡처 불가 시 무시 */
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (cursorCoordsEl) {
    const coordHit = groundHit(e);
    cursorCoordsEl.textContent = coordHit
      ? `X ${coordHit.x.toFixed(1)} · Y ${(-coordHit.z).toFixed(1)} m`
      : "";
  }
  if (rotate) {
    if (!rotate.moved && !pastTapSlop(e)) return;
    rotate.moved = true;
    const hit = groundHit(e);
    if (!hit) return;
    const cur = pointerAngle(rotate.building, hit);
    // 증분 각도를 (-π, π]로 정규화해 누적 — 경계 점프 방지
    let delta = cur - rotate.lastAngle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    rotate.lastAngle = cur;
    rotate.building.offset.rotation += THREE.MathUtils.radToDeg(delta);
    refreshTerrainElevation(rotate.building); // M7 — 회전으로 footprint가 돌면 G.L.도 변함
    applyOffset(rotate.group, rotate.building);
    updateRotationHandle();
    refreshOffsetInfo(rotate.building);
    invalidateAnalysis();
    updateSetbackChecks(); // M3 — 회전 중 실시간 갱신
    return;
  }
  if (!drag) return;
  // 탭 임계값 안의 흔들림은 이동으로 치지 않는다 — 선택하려고 클릭/탭했을 뿐인데
  // 배치가 미세하게 밀리고 invalidateAnalysis()로 PV·일조권 결과가 날아가던 문제
  if (!drag.moved && !pastTapSlop(e)) return;
  drag.moved = true;
  const hit = groundHit(e);
  if (!hit) return;
  // three 좌표 → DXF 평면: dx = Δx, dy = -Δz
  drag.building.offset.dx = drag.startOffset.dx + (hit.x - drag.startHit.x);
  drag.building.offset.dy = drag.startOffset.dy - (hit.z - drag.startHit.z);
  refreshTerrainElevation(drag.building); // M7 — 드래그 중에도 지형 G.L. 추종 (공중부양/매몰 방지)
  applyOffset(drag.group, drag.building);
  updateRotationHandle();
  refreshOffsetInfo(drag.building);
  invalidateAnalysis();
  updateSetbackChecks(); // M3 — 드래그 중 실시간 갱신
});

canvas.addEventListener("pointerup", (e) => {
  if (rotate) {
    // 실제로 돌렸을 때만 보고 — 핸들을 스치기만 해도 "회전 0.0°"가 뜨던 오보 방지
    if (rotate.moved) {
      commitHistory();
      setStatus(
        `${rotate.building.name} 회전: ${rotate.building.offset.rotation.toFixed(1)}°`,
      );
    }
    rotate = null;
    viewer.controls.enabled = true;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    downPos = null;
    return;
  }
  if (drag) {
    if (drag.moved) {
      commitHistory();
      setStatus(
        `${drag.building.name} 이동: (${drag.building.offset.dx.toFixed(1)}, ${drag.building.offset.dy.toFixed(1)})m`,
      );
    }
    drag = null;
    viewer.controls.enabled = true;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }
  // 점 찍기 모드 — 짧은 클릭 위치를 지면 점으로
  if (groundPick) {
    if (!pastTapSlop(e)) {
      const p = terrainPoint(e);
      if (p) {
        const gp = groundPick;
        gp.pts.push(p);
        const elev = terrainSampler();
        const mk = new THREE.Mesh(
          new THREE.SphereGeometry(0.8, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xf5a623, depthTest: false }),
        );
        mk.renderOrder = 999;
        mk.position.set(p.x, (elev ? elev(p.x, p.y) : 0) + 0.5, -p.y);
        viewer.scene.add(mk);
        pickMarkers.push(mk);
        gp.onPoint?.(p, gp.pts.length - 1);
        if (gp.need > 0 && gp.pts.length >= gp.need) gp.resolve(gp.pts);
        else
          setStatus(
            gp.need > 0
              ? `${gp.pts.length}번째 점을 찍었습니다 — 다음 점을 찍으세요 (Esc로 취소)`
              : `${gp.pts.length}개 찍었습니다 — 계속 클릭하거나 Esc로 끝내세요`,
          );
      }
    }
    downPos = null;
    return;
  }
  // 드래그가 아닌 짧은 클릭/탭이면 선택 처리 + 인접건물 면이면 그 지점 일조시간 표시
  if (!pastTapSlop(e)) {
    const group = pickBuilding(e);
    selectBuilding(group ? (group.userData.buildingId as string) : null);
    const surf = pickAdjSurface(e);
    if (surf) showSunProbe(surf.building, surf.point, surf.normal);
    else hideSunProbe();
  }
  downPos = null;
});

// ---------- 인접건물 지점 클릭 → 일조시간 ----------
// 클릭한 벽·지붕 지점에서 기준일 연속(09~15시)·총(08~16시) 직달 일조시간을 바로 계산해 보여준다.
// 차폐 BVH는 배치가 바뀔 때까지 재사용한다(invalidateAnalysis에서 폐기).

let probeMeshes: { after: THREE.Mesh[]; before: THREE.Mesh[] } | null = null;
let probeAnchor: THREE.Vector3 | null = null;
const probeEl = document.createElement("div");
probeEl.className = "sun-probe";
probeEl.hidden = true;
document.body.appendChild(probeEl);
const probeMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.5, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xf5a623, depthTest: false }),
);
probeMarker.renderOrder = 999;
probeMarker.visible = false;
viewer.scene.add(probeMarker);

function disposeProbeMeshes(): void {
  if (!probeMeshes) return;
  disposeObstructionMeshes(probeMeshes.after);
  disposeObstructionMeshes(probeMeshes.before);
  probeMeshes = null;
}

function pickAdjSurface(
  e: PointerEvent,
): { building: Building; point: THREE.Vector3; normal: THREE.Vector3 } | null {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, viewer.camera);
  for (const hit of raycaster.intersectObjects(viewer.buildingsRoot.children, true)) {
    if (!(hit.object instanceof THREE.Mesh) || !hit.face) continue;
    let obj: THREE.Object3D | null = hit.object;
    while (obj && !obj.userData.buildingId) obj = obj.parent;
    if (!obj) continue;
    const b = project.buildings.find((bb) => bb.id === obj!.userData.buildingId);
    if (!b || b.type !== "인접건물") return null; // 가장 가까운 건물이 인접건물이 아니면 측정 안 함
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // 수평 성분만 남겨 벽 법선을 정리 (지붕은 위쪽 그대로)
    if (Math.abs(normal.y) < 0.5) normal.setY(0).normalize();
    else normal.set(0, 1, 0);
    return { building: b, point: hit.point.clone(), normal };
  }
  return null;
}

function showSunProbe(b: Building, point: THREE.Vector3, normal: THREE.Vector3): void {
  syncAnalysisSettings();
  syncSunHoursSettings();
  if (!probeMeshes) {
    probeMeshes = {
      after: buildObstructionMeshes(project.buildings),
      before: buildObstructionMeshes(project.buildings.filter((bb) => bb.type !== "계획주동")),
    };
  }
  const samples = sunHoursSamples(project);
  const step = project.analysis.sunHours.timeStep;
  const now = pointSunHours(samples, step, point, normal, probeMeshes.after);
  const pre = pointSunHours(samples, step, point, normal, probeMeshes.before);
  const ok = (h: { continuous: number; total: number }) => h.continuous >= 2 - 1e-6 || h.total >= 4 - 1e-6;
  const gl = b.terrainElevation ?? 0;
  const isRoof = normal.y > 0.5;
  const floor = Math.min(b.floors, Math.max(1, Math.floor((point.y - gl) / b.floorHeight) + 1));
  const where = isRoof ? "지붕" : `${floor}층 부근 · 지면+${(point.y - gl).toFixed(1)}m`;
  const changed = Math.abs(now.continuous - pre.continuous) > 1e-6 || Math.abs(now.total - pre.total) > 1e-6;
  const use = b.use ? ` · ${FACILITY_USE_LABEL[b.use]}` : "";
  probeEl.innerHTML =
    `<button class="sun-probe-x" aria-label="닫기">✕</button>` +
    `<div class="sp-title">${b.name}${use} · ${where}</div>` +
    `<div class="sp-row"><span>연속 일조 (09~15시)</span><b>${now.continuous.toFixed(1)}시간</b></div>` +
    `<div class="sp-row"><span>총 일조 (08~16시)</span><b>${now.total.toFixed(1)}시간</b></div>` +
    `<div class="sp-verdict ${ok(now) ? "pass" : "fail"}">${ok(now) ? "기준 충족" : "기준 미달"} ` +
    `<small>(연속 2h 또는 총 4h)</small></div>` +
    (changed
      ? `<div class="sp-pre">사업 전: 연속 ${pre.continuous.toFixed(1)}h · 총 ${pre.total.toFixed(1)}h</div>`
      : `<div class="sp-pre">계획주동 영향 없음 (사업 전과 같음)</div>`) +
    `<div class="sp-pre">기준일 ${project.analysis.date} · ${step}분 간격</div>`;
  probeEl.querySelector(".sun-probe-x")!.addEventListener("click", hideSunProbe);
  probeAnchor = point.clone();
  probeMarker.position.copy(point);
  probeMarker.visible = true;
  probeEl.hidden = false;
  positionSunProbe();
}

function hideSunProbe(): void {
  probeAnchor = null;
  probeMarker.visible = false;
  probeEl.hidden = true;
}

/** 카메라가 움직여도 팝업이 측정 지점을 따라가게 매 프레임 위치를 맞춘다 */
function positionSunProbe(): void {
  if (!probeAnchor) return;
  const v = probeAnchor.clone().project(viewer.camera);
  const r = canvas.getBoundingClientRect();
  const behind = v.z > 1;
  probeEl.style.visibility = behind ? "hidden" : "visible";
  probeEl.style.left = `${r.left + ((v.x + 1) / 2) * r.width + 12}px`;
  probeEl.style.top = `${r.top + ((1 - v.y) / 2) * r.height - 12}px`;
  requestAnimationFrame(positionSunProbe);
}

// ---------- 배치안 저장·비교 ----------

const schemeNameInput = document.getElementById("scheme-name") as HTMLInputElement;
const compareModal = document.getElementById("compare-modal") as HTMLElement;

/**
 * 지금 화면의 지표를 굳혀 배치안 metrics로 만든다.
 * 검토 결과는 "실행하지 않음"과 "0건 적합"을 구분해야 하므로,
 * 결과 객체가 없으면 null(미검토)로 남긴다.
 */
function currentSchemeMetrics(): SchemeMetrics {
  syncAllSettings();
  const t = siteUnitTotals(project.buildings);
  const cov = coverageStats(project.buildings, project.site.siteAreaM2, project.analysis.gfaExtra);
  const tally = <T extends { checks: { pass: boolean }[] }>(
    r: T | null,
  ): CheckTally | null =>
    r ? { pass: r.checks.filter((c) => c.pass).length, total: r.checks.length } : null;

  return {
    planCount: t.buildingCount,
    totalUnits: t.total,
    byType: t.byType.map((u) => ({ unitType: u.unitType, count: u.count })),
    coverageM2: cov.coverageM2,
    grossM2: cov.grossM2,
    bcrPct: cov.bcrPct,
    farPct: cov.farPct,
    north: tally(lastNorthSetback),
    daylight: tally(lastDaylight),
    spacing: tally(lastSpacing),
    analyses: [...mainBoardEntries(), ...analysisBoard()]
      .filter((e) => !["정북사선", "채광사선", "인동거리"].includes(e.title))
      .map((e) => ({ title: e.title, value: e.value })),
  };
}

function refreshSchemeList(): void {
  renderSchemeList(listSchemes(), {
    onLoad: (rec) => {
      try {
        // 배치안 불러오기는 배치만 바꾼다 — 저장한 시점 목록은 지금 것을 유지
        const plan = deserializeView(rec.view);
        delete plan.savedViews;
        applyViewData(plan);
        setStatus(
          `배치안 "${rec.name}" 불러옴 — 장면 ${project.buildings.length}동 · ` +
            `${rec.metrics.totalUnits}세대 (저장 ${formatSavedAt(rec.savedAt)})`,
        );
      } catch (err) {
        setStatus(`배치안 불러오기 실패: ${(err as Error).message}`);
        console.error(err);
      }
    },
    onDelete: (rec) => {
      deleteScheme(rec.id);
      refreshSchemeList();
      setStatus(`배치안 "${rec.name}" 삭제됨`);
    },
  });
}

document.getElementById("save-scheme")!.addEventListener("click", () => {
  if (project.buildings.length === 0) {
    setStatus("저장할 배치가 없습니다 — 먼저 주동을 배치하세요.");
    return;
  }
  // 이름을 비워두면 "A안, B안 …"으로 자동 부여
  const auto = `${String.fromCharCode(65 + (listSchemes().length % 26))}안`;
  const name = schemeNameInput.value.trim() || auto;
  try {
    const view = serializeView(project, sceneOrigin, { dxfLoadSeq, sceneSeq });
    const rec = saveScheme(name, currentSchemeMetrics(), view);
    schemeNameInput.value = "";
    refreshSchemeList();
    setStatus(
      `배치안 "${rec.name}" 저장됨 — ${rec.metrics.planCount}동 · ${rec.metrics.totalUnits}세대 ` +
        `(브라우저 저장 · 영구 보관은 "파일 → 프로젝트 저장")`,
    );
  } catch (err) {
    setStatus(`배치안 저장 실패: ${(err as Error).message}`);
  }
});

document.getElementById("compare-schemes")!.addEventListener("click", () => {
  renderCompareTable(listSchemes());
  compareModal.hidden = false;
});

document.getElementById("close-compare")!.addEventListener("click", () => {
  compareModal.hidden = true;
});

compareModal.addEventListener("click", (e) => {
  if (e.target === compareModal) compareModal.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (groundPick) {
    // 개수 제한 없는 모드(가로수 심기)는 Esc가 "끝" — 찍은 점까지 반영
    if (groundPick.need === 0 && groundPick.pts.length) groundPick.resolve(groundPick.pts);
    else {
      groundPick.resolve(null);
      setStatus("점 찍기를 취소했습니다.");
    }
  }
  if (!floorsModal.hidden) floorsModal.hidden = true;
  if (!compareModal.hidden) compareModal.hidden = true;
  hideSunProbe();
  if (!lockModal.hidden) lockModal.hidden = true; // 답하지 않으면 고정 상태 유지
  // 초기화 확인은 Esc를 "취소"로 — 실수로 진행되지 않게
  const reset = document.getElementById("reset-modal");
  if (reset && !reset.hidden) reset.hidden = true;
});

refreshSchemeList();

// ---------- 표준 시점 버튼 (캔버스 우상단) ----------

/**
 * 마지막으로 고른 표준 시점 — DXF 내보내기가 어느 시점으로 나갈지 결정한다.
 * 카메라를 직접 돌려도 이 값은 유지된다(자유 시점은 도면화 대상이 아니므로
 * 마지막 표준 시점을 기준으로 내보내는 편이 예측 가능하다).
 */
let exportView: ViewPreset = "top";

for (const btn of document.querySelectorAll<HTMLButtonElement>("#view-presets [data-view]")) {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.view as ViewPreset;
    exportView = preset;
    viewer.setViewPreset(preset);
    // 마지막으로 고른 시점을 표시 — 회전하면 어긋나지만 "어디서 왔는지" 단서가 된다
    for (const other of document.querySelectorAll("#view-presets [data-view]")) {
      other.classList.toggle("active", other === btn);
    }
    setStatus(`시점: ${VIEW_PRESET_LABEL[preset]}`);
  });
}


// ---------- 화면 범례(키맵) ----------
// 분석 결과가 화면에 떠 있는 동안 색의 의미를 3D 화면 좌하단에 함께 보여준다.
// JPG 저장 시에도 같은 범례를 이미지에 그려 넣는다.

function currentLegends(): LegendItem[] {
  const out: LegendItem[] = [];
  if (lastSunHours) {
    const r = lastSunHours;
    const verdicts = r.summaries.map((s) => judgeBuilding(s, r.passRatio));
    const pass = verdicts.filter((v) => v === "pass").length;
    const fail = verdicts.filter((v) => v === "fail").length;
    const rule =
      r.rule === "continuous" ? "연속 2h(9~15시)" : r.rule === "total" ? "총 4h(8~16시)" : "연속 2h 또는 총 4h";
    out.push({
      kind: "swatches",
      title: `일조권 — ${rule}`,
      items: [
        { color: "#4c8bf5", label: "기준 충족" },
        { color: "#e5484d", label: "기준 미달" },
      ],
      note: `인접 건물 ${pass + fail}동 중 적합 ${pass} · 미달 ${fail}`,
    });
  }
  if (lastFacility) {
    const counts = new Map<string, number>();
    for (const pt of lastFacility.points) counts.set(pt.status, (counts.get(pt.status) ?? 0) + 1);
    const order = ["ok", "project", "worse", "existing"] as const;
    out.push({
      kind: "swatches",
      title: "유치원·학교·교회 창문 일조",
      items: order.map((k) => ({
        color: facilityStatusColor(k),
        label: `${FACILITY_STATUS_LABEL[k]} ${counts.get(k) ?? 0}`,
      })),
      note: `측정점 ${lastFacility.points.length}개 · 사업 전후 비교`,
    });
  }
  if (lastSunHoursMap && sunHoursMapGroup) {
    const m = lastSunHoursMap;
    if (sunMapLegalCheckbox.checked) {
      out.push({
        kind: "swatches",
        title: "일조시간 지도 — 법적 기준",
        items: [
          { color: "#4c8bf5", label: "연속 2h 또는 총 4h 충족" },
          { color: "#e5484d", label: "미달" },
        ],
        note: `기준일 ${m.legalDate}`,
      });
    } else {
      out.push({
        kind: "gradient",
        title: `일조시간 지도 (${m.date})`,
        stops: gradientFromStops(HOUR_STOPS, 8),
        ticks: [0, 2, 4, 6, 8].map((h) => ({ at: h / 8, label: h === 8 ? "8h+" : `${h}h` })),
        note:
          `평균 ${m.stats.avg.toFixed(1)}h` +
          (m.groundAvg !== null ? ` · 지면 평균 ${m.groundAvg.toFixed(1)}h` : ""),
      });
    }
  }
  const windTicks = [
    { at: 0, label: "정체" },
    { at: 0.25, label: "0.5" },
    { at: 0.5, label: "1.0(주풍)" },
    { at: 0.75, label: "1.5" },
    { at: 1, label: "2.0+" },
  ];
  if (lastWind && windGroup) {
    out.push({
      kind: "gradient",
      title: "바람길 — 풍속비 (국지 풍속 / 주풍속)",
      stops: gradientFromStops(WIND_RATIO_STOPS, 2),
      ticks: windTicks,
      note:
        `${lastWind.month === null ? "연간" : `${lastWind.month}월`} 주풍향 ${windDirLabel(lastWind.windDir)} ` +
        `${lastWind.windSpeedMs.toFixed(1)}m/s · 화살표 = 흐름 방향`,
    });
  }
  if (lastLbm) {
    if (lbmStreamGroup?.visible) {
      out.push({
        kind: "gradient",
        title: "바람길 LBM — 유선 풍속비",
        stops: gradientFromStops(WIND_RATIO_STOPS, 2),
        ticks: windTicks,
        note:
          `풍향 ${windDirLabel(lastLbm.windDirDeg)}(${lastLbm.windDirDeg.toFixed(0)}°) ` +
          `${lastLbm.windSpeedMs.toFixed(1)}m/s · 화살표 = 흐름 방향`,
      });
    }
    if (lbmHeatmap?.mesh.visible) {
      out.push({
        kind: "gradient",
        title: "바람길 LBM — 바닥 풍속비",
        stops: RATIO_STOPS.map(([v, [r, g, b]]) => ({
          at: v / 2,
          color: `rgb(${r},${g},${b})`,
        })),
        ticks: windTicks,
      });
    }
  }
  return out;
}

function updateLegends(): void {
  // 초기화 도중(아래쪽 변수 선언 전)에 불려도 안전하도록 매번 찾고 예외는 무시
  const el = document.getElementById("view-legend");
  if (!el) return;
  try {
    renderLegendPanel(el, [...currentLegends(), ...analysisLegends()]);
    const board = document.getElementById("result-board-body");
    if (board) renderResultBoard(board, [...mainBoardEntries(), ...analysisBoard()], (p) => flyToPoint(p));
  } catch {
    /* 초기화 전 — 다음 갱신 때 그린다 */
  }
}

/** 건물 중심(three 좌표, 중간 높이) — 결과판에서 위치로 이동할 때 */
function buildingCenterById(id: string): THREE.Vector3 | undefined {
  const b = project.buildings.find((x) => x.id === id);
  if (!b) return undefined;
  const c = footprintCentroid(worldFootprint(b));
  return new THREE.Vector3(c.x, (b.terrainElevation ?? 0) + buildingHeight(b) / 2, -c.y);
}

/** 3D 화면을 한 점으로 — 지금 보는 방향은 유지하고 거리만 맞춘다 */
function flyToPoint(p: THREE.Vector3, dist = 90): void {
  const cur = viewer.getCameraView();
  const dir = new THREE.Vector3(...cur.position).sub(new THREE.Vector3(...cur.target));
  if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1);
  dir.setLength(dist);
  const pos = p.clone().add(dir);
  viewer.flyTo([pos.x, pos.y, pos.z], [p.x, p.y, p.z]);
}

/** 기존 검토(정북·채광·인동·일조권·시설·바람)의 결과판 항목 */
function mainBoardEntries(): BoardEntry[] {
  const out: BoardEntry[] = [];
  if (lastNorthSetback && lastNorthSetback.checks.length > 0) {
    const fails = lastNorthSetback.checks.filter((c) => !c.pass);
    out.push({
      title: "정북사선",
      value: fails.length === 0 ? `${lastNorthSetback.checks.length}동 모두 적합` : `위반 ${fails.length} / ${lastNorthSetback.checks.length}동`,
      verdict: fails.length === 0 ? "ok" : "bad",
      items: fails.map((c) => ({
        label: `${c.buildingName} — 높이 ${c.actualHeight.toFixed(1)}m > 허용 ${c.allowedHeight?.toFixed(1)}m`,
        verdict: "bad" as const,
        at: buildingCenterById(c.buildingId),
      })),
    });
  }
  if (lastDaylight && lastDaylight.checks.length > 0) {
    const byB = new Map<string, { name: string; fail: number; n: number }>();
    for (const c of lastDaylight.checks) {
      const e = byB.get(c.buildingId) ?? { name: c.buildingName, fail: 0, n: 0 };
      e.n++;
      if (!c.pass) e.fail++;
      byB.set(c.buildingId, e);
    }
    const bad = [...byB].filter(([, e]) => e.fail > 0);
    out.push({
      title: "채광사선",
      value: bad.length === 0 ? `${byB.size}동 모두 적합` : `위반 ${bad.length} / ${byB.size}동`,
      verdict: bad.length === 0 ? "ok" : "bad",
      items: bad.map(([id, e]) => ({
        label: `${e.name} — 창 ${e.fail}곳 위반`,
        verdict: "bad" as const,
        at: buildingCenterById(id),
      })),
    });
  }
  if (lastSpacing && lastSpacing.checks.length > 0) {
    const fails = lastSpacing.checks.filter((c) => !c.pass);
    out.push({
      title: "인동거리",
      value: fails.length === 0 ? `${lastSpacing.checks.length}쌍 모두 적합` : `위반 ${fails.length} / ${lastSpacing.checks.length}쌍`,
      verdict: fails.length === 0 ? "ok" : "bad",
      items: fails.map((c) => ({
        label: `${c.aName} ↔ ${c.bName} — ${c.distance.toFixed(1)}m < ${c.required.toFixed(1)}m`,
        verdict: "bad" as const,
        at: new THREE.Vector3((c.pa.x + c.pb.x) / 2, 10, -(c.pa.y + c.pb.y) / 2),
      })),
    });
  }
  if (lastSunHours) {
    const r = lastSunHours;
    const items: BoardItem[] = r.summaries
      .map((s) => ({ s, v: judgeBuilding(s, r.passRatio) }))
      .filter(({ v }) => v !== "na")
      .map(({ s, v }) => ({
        label: `${s.name} — ${v === "pass" ? "적합" : "미달"}`,
        verdict: v === "pass" ? ("ok" as const) : ("bad" as const),
        at: buildingCenterById(s.buildingId),
      }));
    const fail = items.filter((i) => i.verdict === "bad").length;
    out.push({
      title: "일조권 (인접건물)",
      value: `${items.length}동 중 미달 ${fail}동`,
      verdict: fail === 0 ? "ok" : "bad",
      items,
    });
  }
  if (lastFacility && lastFacility.summaries.length > 0) {
    const aff = lastFacility.summaries.filter((s) => s.affected);
    out.push({
      title: "유치원·학교·교회 일조",
      value: `${lastFacility.summaries.length}동 중 사업 영향 ${aff.length}동`,
      verdict: aff.length === 0 ? "ok" : "bad",
      items: lastFacility.summaries.map((s) => ({
        label: `${s.name} — ${s.affected ? `사업 영향 (미달 ${s.counts.project}·감소 ${s.counts.worse})` : "영향 없음"}`,
        verdict: s.affected ? ("bad" as const) : ("ok" as const),
        at: buildingCenterById(s.buildingId),
      })),
    });
  }
  if (lastSunHoursMap) {
    out.push({
      title: `일조시간 지도 (${lastSunHoursMap.date})`,
      value:
        `평균 ${lastSunHoursMap.stats.avg.toFixed(1)}h` +
        (lastSunHoursMap.groundAvg !== null ? ` · 지면 ${lastSunHoursMap.groundAvg.toFixed(1)}h` : ""),
      verdict: "info",
    });
  }
  if (lastWind) {
    out.push({
      title: "바람길 (간이)",
      value: `주풍향 ${windDirLabel(lastWind.windDir)} ${lastWind.windSpeedMs.toFixed(1)}m/s · 바람그림자 ${lastWind.shadowAreaM2.toFixed(0)}㎡`,
      verdict: "info",
    });
  }
  if (lastLbm) {
    out.push({
      title: "바람길 LBM",
      value: `최대 증가율 +${((lastLbm.maxRatio - 1) * 100).toFixed(0)}% · 바람 그늘 ${lastLbm.shadowAreaM2.toFixed(0)}㎡`,
      verdict: lastLbm.maxRatio > 1.5 ? "warn" : "info",
    });
  }
  return out;
}

// ---------- 추가 분석 모듈 ----------
const analysisCtx: AnalysisContext = {
  project,
  viewer,
  elevate: () => terrainSampler(),
  surface: () => (terrainVisible ? drapeSurface() : undefined),
  setStatus,
  changed: () => updateLegends(),
  flyTo: (p, d) => flyToPoint(p, d),
  extras: {
    lastLbm: () => lastLbm,
    loadWindRose: () => loadWindRose(windEpwSelect.value),
    windRefHeight: () => Math.max(0, parseFloat(windRefHeightInput.value) || 0),
  },
  sceneOrigin: () => sceneOrigin,
  pickGroundPoints: (n, prompt, onPoint) => pickGroundPoints(n, prompt, onPoint),
  commitHistory: () => commitHistory(),
  async saveFile(blob, filename, description, accept) {
    const picked = await saveToDesktop(blob, filename, description, accept);
    if (picked === "cancelled") {
      setStatus("저장 취소됨");
      return;
    }
    if (picked !== "unsupported") {
      setStatus(`저장 — ${picked}`);
      return;
    }
    const out = await shareOrDownload(new File([blob], filename, { type: blob.type }), filename);
    setStatus(out === "cancelled" ? "공유 취소됨" : `${out === "shared" ? "공유함" : "저장"} — ${filename}`);
  },
};
initAnalyses(analysisCtx);
registerAnalysis(createUnitSunModule(analysisCtx));
registerAnalysis(createShadowPlanModule(analysisCtx));
registerAnalysis(createShadeWalkModule(analysisCtx));
registerAnalysis(createThermalModule(analysisCtx));
registerAnalysis(createNoiseModule(analysisCtx));
registerAnalysis(createSkyViewModule(analysisCtx));
registerAnalysis(createPrivacyModule(analysisCtx));
registerAnalysis(createSkylineModule(analysisCtx));
setupPanelTabs();

// ---------- 왼쪽 패널 탭 + 탭 전체 실행 ----------
function setupPanelTabs(): void {
  const wrap = document.querySelector<HTMLElement>("#left-panel .lp-acc-wrap");
  if (!wrap) return;
  type Tab = "law" | "sun" | "env" | "set";
  const TABS: [Tab, string][] = [["law", "법규"], ["sun", "일조"], ["env", "환경"], ["set", "설정·파일"]];
  const byId: Record<string, Tab> = {
    "sunhoursmap-section": "sun", "unitsun-section": "sun", "shadowplan-section": "sun",
    "wind-section": "env", "shadewalk-section": "env", "thermal-section": "env", "noise-section": "env",
    "skyview-section": "env", "privacy-section": "env", "skyline-section": "env",
    "terrain-section": "set", "schemes-section": "set",
  };
  const byTitle: [string, Tab][] = [["기본 설정", "set"], ["정북", "law"], ["일조권", "sun"], ["유치원", "sun"]];
  const sections = [...wrap.querySelectorAll<HTMLDetailsElement>("details.lp-acc")];
  for (const d of sections) {
    const title = d.querySelector("summary")?.textContent ?? "";
    d.dataset.tab = byId[d.id] ?? byTitle.find(([t]) => title.startsWith(t))?.[1] ?? "set";
  }
  // 탭별 실행 버튼 (오래 걸리는 LBM·입면 창은 제외)
  const RUN: Record<Tab, string[]> = {
    law: [],
    sun: ["run-sunhours", "run-facility", "run-unitsun", "run-shadowplan", "run-sunhoursmap"],
    env: ["run-wind", "run-shadewalk", "run-thermal", "run-noise", "run-skyview", "run-privacy"],
    set: [],
  };
  const bar = document.createElement("div");
  bar.className = "lp-tabs";
  const runRow = document.createElement("div");
  runRow.className = "row lp-tab-run";
  const runBtn = document.createElement("button");
  runBtn.className = "btn mini block";
  runRow.append(runBtn);
  let cur: Tab = "law";
  try {
    cur = (localStorage.getItem("lpTab") as Tab) || "law";
  } catch {
    /* 저장소 없음 */
  }
  const show = (t: Tab) => {
    cur = t;
    try {
      localStorage.setItem("lpTab", t);
    } catch {
      /* 저장소 없음 */
    }
    for (const b of bar.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.tab === t);
    for (const d of sections) d.hidden = d.dataset.tab !== t;
    runRow.hidden = RUN[t].length === 0;
    runBtn.textContent = `이 탭 분석 모두 실행 (${RUN[t].length}개)`;
  };
  for (const [t, label] of TABS) {
    const b = document.createElement("button");
    b.dataset.tab = t;
    b.textContent = label;
    b.addEventListener("click", () => show(t));
    bar.append(b);
  }
  runBtn.addEventListener("click", async () => {
    if (project.buildings.length === 0) {
      setStatus("먼저 DXF를 불러오세요.");
      return;
    }
    runBtn.disabled = true;
    const ids = RUN[cur];
    const done: string[] = [];
    try {
      for (const id of ids) {
        const b = document.getElementById(id) as HTMLButtonElement | null;
        if (!b || b.disabled) continue;
        b.click();
        await new Promise((r) => setTimeout(r, 150));
        // 실행 중에는 버튼이 비활성 — 끝날 때까지 기다린다 (최대 10분)
        for (let i = 0; i < 3000 && b.disabled; i++) await new Promise((r) => setTimeout(r, 200));
        done.push(b.closest("details")?.querySelector("summary")?.textContent ?? id);
      }
      setStatus(`탭 전체 실행 완료 — ${done.length}개 (${done.join(", ")}) · 오른쪽 결과판에서 확인하세요`);
    } finally {
      runBtn.disabled = false;
    }
  });
  wrap.prepend(bar, runRow);
  show(TABS.some(([t]) => t === cur) ? cur : "law");
}

// ---------- 시점 저장 · JPG 내보내기 ----------

const savedViewsEl = document.getElementById("saved-views") as HTMLElement;

function renderSavedViews(): void {
  savedViewsEl.replaceChildren();
  project.savedViews.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "saved-view";
    const go = document.createElement("button");
    go.className = "btn mini";
    go.textContent = v.name;
    go.title = "이 시점으로 이동 (더블클릭: 이름 바꾸기)";
    go.addEventListener("click", () => {
      viewer.flyTo(v.position, v.target);
      for (const b of document.querySelectorAll("#view-presets [data-view], #saved-views .btn")) {
        b.classList.toggle("active", b === go);
      }
      setStatus(`시점: ${v.name}`);
    });
    go.addEventListener("dblclick", () => {
      const name = prompt("시점 이름", v.name)?.trim();
      if (name) {
        v.name = name;
        renderSavedViews();
      }
    });
    const del = document.createElement("button");
    del.className = "sv-del";
    del.textContent = "×";
    del.title = "이 시점 삭제";
    del.addEventListener("click", () => {
      project.savedViews.splice(i, 1);
      renderSavedViews();
      setStatus(`시점 "${v.name}" 삭제`);
    });
    row.append(go, del);
    savedViewsEl.append(row);
  });
}

document.getElementById("save-cam-view")!.addEventListener("click", () => {
  let n = project.savedViews.length + 1;
  while (project.savedViews.some((v) => v.name === `뷰 ${n}`)) n++;
  const name = `뷰 ${n}`;
  project.savedViews.push({ name, ...viewer.getCameraView() });
  renderSavedViews();
  setStatus(`지금 시점을 "${name}"(으)로 저장했습니다 — 버튼을 누르면 이 시점으로 돌아옵니다 (더블클릭으로 이름 변경, .view 저장 시 함께 저장)`);
});

/** 저장 이미지 오른쪽 위 방위표 + (평면에 가까운 시점이면) 축척 막대 */
function drawCompassAndScale(ctx: CanvasRenderingContext2D, w: number, h: number, s: number): void {
  const ang = viewer.screenNorthAngle(project.site.northAngle);
  const cx = w - 40 * s, cy = 40 * s, r = 22 * s;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.8);
  ctx.lineTo(r * 0.32, r * 0.45);
  ctx.lineTo(0, r * 0.2);
  ctx.lineTo(-r * 0.32, r * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.font = `700 ${11 * s}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("N", 0, -r - 4 * s);
  ctx.restore();
  // 축척 막대 — 거의 내려다볼 때만 의미가 있다
  const { pxPerM, downness } = viewer.scaleAtTarget();
  if (downness < 0.85 || pxPerM <= 0) return;
  const want = (w / s) * 0.15 / pxPerM;
  const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v >= want) ?? 1000;
  const len = nice * pxPerM * s;
  const x1 = w - 24 * s, x0 = x1 - len, y = h - 28 * s;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(x0 - 8 * s, y - 20 * s, len + 16 * s, 30 * s);
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(x0, y, len / 2, 4 * s);
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(x0, y, len, 4 * s);
  ctx.font = `600 ${11 * s}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(`${nice}m`, x0 + len / 2, y - 6 * s);
  ctx.restore();
}

document.getElementById("model-style-btn")!.addEventListener("click", (e) => {
  viewer.setModelStyle(!viewer.modelStyle);
  (e.currentTarget as HTMLElement).classList.toggle("active", viewer.modelStyle);
  setStatus(viewer.modelStyle ? "모형 스타일 — 흰 점토 매스 + 부드러운 음영 (JPG 저장에도 반영)" : "기본 화면으로 돌아왔습니다.");
});
document.getElementById("labels-btn")!.addEventListener("click", (e) => {
  labelsOn = !labelsOn;
  (e.currentTarget as HTMLElement).classList.toggle("active", labelsOn);
  refreshLabels();
});

async function exportJpg(whiteBackground: boolean): Promise<void> {
  const stamp = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  const filename =
    `arch_view_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.jpg`;
  try {
    const legends = currentLegends();
    const blob = await viewer.captureJpeg(
      0.92,
      (ctx, w, h, scale) => {
        drawLegendsOnCanvas(ctx, legends, h, scale);
        drawCompassAndScale(ctx, w, h, scale);
      },
      { whiteBackground },
    );
    const picked = await saveToDesktop(blob, filename, "JPG 이미지", {
      "image/jpeg": [".jpg", ".jpeg"],
    });
    if (picked === "cancelled") {
      setStatus("이미지 저장 취소됨");
      return;
    }
    if (picked !== "unsupported") {
      setStatus(`화면 이미지 저장 — ${picked}`);
      return;
    }
    const outcome = await shareOrDownload(
      new File([blob], filename, { type: "image/jpeg" }),
      "arch_view 화면",
    );
    setStatus(
      outcome === "cancelled" ? "공유 취소됨" : `화면 이미지 ${outcome === "shared" ? "공유함" : "저장"} — ${filename}`,
    );
  } catch (err) {
    setStatus(`이미지 저장 실패: ${(err as Error).message}`);
    console.error(err);
  }
}
document.getElementById("export-jpg")!.addEventListener("click", () => void exportJpg(false));
document.getElementById("export-jpg-white")!.addEventListener("click", () => void exportJpg(true));

renderSavedViews();

// 사용자가 직접 회전·이동하면 프리셋 표시를 해제 (더 이상 그 시점이 아니므로)
viewer.controls.addEventListener("start", () => {
  for (const b of document.querySelectorAll("#view-presets [data-view], #saved-views .btn")) {
    b.classList.remove("active");
  }
});

refreshList();
refreshLibraryList();
syncAnalysisSettings();
updateSunFromSlider();
updateSetbackChecks();
resetHistory();

// 개발용 디버그 훅
if (import.meta.env.DEV) {
  (window as any).__app = {
    project,
    viewer,
    groups,
    rebuildAll: () => rebuildAll(),
    runNorthSetbackCheck,
    getLastNorthSetback: () => lastNorthSetback,
    buildingHeight,
    // M3
    runDaylightCheck,
    runSpacingCheck,
    updateSetbackChecks,
    applyOffset: (b: Building) => {
      const g = groups.get(b.id);
      if (g) applyOffset(g, b);
    },
    getSetbackState: () => ({ daylightOn, spacingOn }),
    // 일조권 검토
    runSunHoursCheck,
    getLastSunHours: () => lastSunHours,
    // M6
    totalUnits,
    unitBreakdown,
    siteUnitTotals,
    // M8
    loadWindRose,
    computeWindField,
    traceStreamlines,
    getLastWind: () => lastWind,
    // M9
    runSunHoursMap,
    getLastSunHoursMap: () => lastSunHoursMap,
  };
}

// ---------- 불러오기: 바탕화면에서 시작하는 열기 창 ----------
// 파일 메뉴의 "DXF 불러오기·DXF 추가·프로젝트 열기"는 숨긴 <input type=file>과 연결된 라벨이다.
// 지원 브라우저에서는 라벨 클릭을 가로채 바탕화면이 열린 창으로 고르고, 고른 파일을 같은 input에
// 넣어 change를 발생시킨다 — 기존 처리 경로를 그대로 타므로 불러오기 동작이 갈라지지 않는다.
if (canPickDesktop()) {
  const targets: { inputId: string; description: string; accept: Record<string, string[]> }[] = [
    { inputId: "dxf-file", description: "DXF 도면", accept: { "application/dxf": [".dxf"] } },
    { inputId: "dxf-file-add", description: "DXF 도면", accept: { "application/dxf": [".dxf"] } },
    { inputId: "view-file", description: "arch_view 프로젝트", accept: { "application/json": [".view"] } },
  ];
  for (const t of targets) {
    const input = document.getElementById(t.inputId) as HTMLInputElement | null;
    if (!input) continue;
    for (const label of document.querySelectorAll<HTMLLabelElement>(`label[for="${t.inputId}"]`)) {
      label.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const file = await openFromDesktop(t.description, t.accept);
          if (file === "unsupported") {
            input.click();
            return;
          }
          if (!file) return; // 창을 닫음
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (err) {
          setStatus(`파일 열기 실패: ${(err as Error).message}`);
          console.error(err);
        }
      });
    }
  }
}
