import * as THREE from "three";
import {
  applyRecenterOffset,
  computeRecenterOffset,
  parseDxfBuildings,
  unitSourceLabel,
  type UnitMode,
} from "./dxf";
import { Viewer } from "./viewer";
import {
  applyOffset,
  createBuildingObject,
  createOverlayGroup,
  footprintCentroid,
  mirrorBuilding,
  setSelected,
} from "./buildings";
import { createDaylightOverlay, runDaylightCheck, type DaylightResult } from "./daylight";
import {
  createNorthSetbackOverlay,
  runNorthSetbackCheck,
  type NorthSetbackResult,
} from "./northsetback";
import {
  createPvOverlay,
  pvResultToCsv,
  runPvAnalysis,
  type PvResult,
} from "./pv";
import { exportXlsx } from "./excel";
import { buildDxfText, hasExportContent } from "./dxfexport";
import { deserializeView, serializeView } from "./viewfile";
import { EPW_FILES, parseEpw, type EpwData } from "./epw";
import {
  createPvEnergyOverlay,
  runPvEnergyAnalysis,
  type PvEnergyResult,
} from "./pvenergy";
import {
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
import { createSunHoursOverlay, runSunHoursCheck, type SunHoursResult } from "./sunhours";
import {
  createSunHoursMapOverlay,
  disposeSunHoursMapOverlay,
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
  windDirLabel,
  type WindResult,
  type WindRoseData,
} from "./wind";
import {
  buildingHeight,
  defaultProject,
  mirrorLabel,
  seoulSetbackRules,
  statutorySetbackRules,
  type Building,
  type MassType,
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
  renderPvEnergySummary,
  renderPvSummary,
  renderSetbackSummary,
  renderSiteTotals,
  renderSunHoursMapSummary,
  renderSunHoursSummary,
  renderWindSummary,
  setStatus,
  type BuildingStatus,
} from "./ui";

const project: Project = defaultProject();
const viewer = new Viewer(document.getElementById("viewport")!);
const groups = new Map<string, THREE.Group>();
let selectedId: string | null = null;
let lastNorthSetback: NorthSetbackResult | null = null;
let lastSunHours: SunHoursResult | null = null;
let sunHoursRunning = false;
let lastPv: PvResult | null = null;
let pvRunning = false;
let lastPvEnergy: PvEnergyResult | null = null;
let pvEnergyRunning = false;
let lastWind: WindResult | null = null;
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

// ---------- 건물 씬 구성 ----------

function rebuildAll(): void {
  for (const g of groups.values()) disposeGroup(g);
  viewer.buildingsRoot.clear();
  groups.clear();
  for (const b of project.buildings) {
    const g = createBuildingObject(b);
    groups.set(b.id, g);
    viewer.buildingsRoot.add(g);
  }
}

function rebuildOne(b: Building): void {
  const old = groups.get(b.id);
  if (old) {
    viewer.buildingsRoot.remove(old);
    disposeGroup(old);
  }
  const g = createBuildingObject(b);
  groups.set(b.id, g);
  viewer.buildingsRoot.add(g);
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
      const total = s.wall.totalCells + s.roof.totalCells;
      cur.sh =
        total === 0
          ? "na"
          : s.wall.passCells === s.wall.totalCells && s.roof.passCells === s.roof.totalCells
            ? "pass"
            : "fail";
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
  renderBuildingList(project.buildings, selectedId, computeStatusMap(), {
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
  });
  updateSiteTotals();
}

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
function duplicateBuilding(b: Building): void {
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
  viewer.overlaysRoot.add(createOverlayGroup(project.siteOverlays));
}

function loadDxfText(text: string, sourceName: string, merge: boolean): void {
  const unitMode = (document.getElementById("unit-select") as HTMLSelectElement)
    .value as UnitMode;
  try {
    const { buildings, overlays, warnings, unitSource } = parseDxfBuildings(
      text,
      unitMode,
    );
    dxfLoadSeq++;
    for (const b of buildings) b.id = `L${dxfLoadSeq}-${b.id}`;

    if (merge && sceneOrigin) {
      applyRecenterOffset(sceneOrigin, buildings, overlays);
      project.siteOverlays.push(...overlays);
    } else {
      sceneOrigin = computeRecenterOffset(buildings, overlays);
      applyRecenterOffset(sceneOrigin, buildings, overlays);
      project.siteOverlays = overlays;
      // 새 프로젝트 시작 — 장면·라이브러리 모두 초기화
      project.buildings = [];
      project.buildingLibrary = [];
      libraryCheckedIds.clear();
      cloneOrigin.clear();
      selectedId = null;
    }

    // PLAN_BLDG는 라이브러리에 쌓아두고 사용자가 "장면에 추가"로 골라 넣는다.
    // ADJ_BLDG는 기존 동작대로 즉시 장면에 반영(기존 실제 건물이라 재사용 개념이 없음).
    const planBuildings = buildings.filter((b) => b.type === "계획주동");
    const adjBuildings = buildings.filter((b) => b.type === "인접건물");
    project.buildingLibrary.push(...planBuildings);
    for (const b of planBuildings) libraryCheckedIds.add(b.id); // 기본 전체 선택
    project.buildings.push(...adjBuildings);

    rebuildAll();
    rebuildOverlays();
    viewer.fitToBuildings();
    refreshList();
    refreshLibraryList();
    updateRotationHandle();
    invalidateAnalysis();
    updateSetbackChecks();
    const winCount = buildings.reduce((s, b) => s + b.windowSegments.length, 0);
    let msg =
      `${sourceName} ${merge ? "병합" : "불러옴"} (${unitSourceLabel(unitSource)}) — ` +
      `계획주동 ${planBuildings.length}동을 라이브러리에 담음, 인접건물 ${adjBuildings.length}동 배치됨 ` +
      `— "건물 라이브러리"에서 장면에 추가하세요`;
    if (overlays.length > 0) msg += `, 오버레이 ${overlays.length}개`;
    if (winCount > 0) msg += `, 창면 ${winCount}개`;
    if (warnings.length > 0) msg += ` (경고 ${warnings.length}건 — 마우스를 올리면 내용 표시)`;
    setStatus(msg, warnings.length > 0 ? warnings.join("\n\n") : undefined);
    for (const w of warnings) console.warn("[DXF]", w);
  } catch (err) {
    setStatus(`불러오기 실패: ${(err as Error).message}`);
    console.error(err);
  }
}

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

function findLibraryBuilding(id: string): Building | undefined {
  return sampleLibrary.find((b) => b.id === id) ?? project.buildingLibrary.find((b) => b.id === id);
}

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

function addLibrarySelectionToScene(): void {
  if (libraryCheckedIds.size === 0) {
    setStatus("장면에 추가할 건물을 라이브러리에서 선택하세요.");
    return;
  }
  let added = 0;
  for (const libId of libraryCheckedIds) {
    const lib = findLibraryBuilding(libId);
    if (!lib) continue;
    const existingCount = [...cloneOrigin.values()].filter((v) => v === libId).length;
    const clone = cloneBuildingFromLibrary(lib, existingCount > 0 ? -20 * existingCount : 0);
    project.buildings.push(clone);
    added++;
  }
  if (added === 0) return;
  rebuildAll();
  viewer.fitToBuildings();
  refreshList();
  updateRotationHandle();
  invalidateAnalysis();
  updateSetbackChecks();
  updateSiteTotals();
  setStatus(`장면에 ${added}동 추가됨`);
}

document.getElementById("library-select-all")!.addEventListener("click", () => {
  for (const b of [...sampleLibrary, ...project.buildingLibrary]) libraryCheckedIds.add(b.id);
  refreshLibraryList();
});

document.getElementById("library-select-none")!.addEventListener("click", () => {
  libraryCheckedIds.clear();
  refreshLibraryList();
});

document.getElementById("library-add-scene")!.addEventListener("click", () => {
  addLibrarySelectionToScene();
});

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

document.getElementById("load-sample")!.addEventListener("click", async () => {
  const res = await fetch("/sample_site.dxf");
  if (!res.ok) {
    setStatus("샘플 파일을 찾을 수 없습니다.");
    return;
  }
  // 샘플은 data/DXF_RULES.md 규약에 따라 mm 단위($INSUNITS=4)로 작성됨 — 자동감지로 확인
  (document.getElementById("unit-select") as HTMLSelectElement).value = "auto";
  loadDxfText(await res.text(), "샘플 배치도", false);
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
    refreshStatusDots(computeStatusMap());
  }
  if (lastPv) {
    lastPv = null;
    clearGroup(pvRoot);
    renderPvSummary(null, note);
  }
  if (lastPvEnergy) {
    lastPvEnergy = null;
    clearGroup(pvEnergyRoot);
    renderPvEnergySummary(null, note);
  }
  if (lastWind) {
    lastWind = null;
    clearWindOverlay();
    renderWindSummary(null, note);
  }
  if (lastSunHoursMap) {
    lastSunHoursMap = null;
    clearSunHoursMapOverlay();
    renderSunHoursMapSummary(null, note);
  }
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

// ---------- 태양광(PV) 상대평가 (M4) ----------
// 모드 B 1단계: 대표일 4일(춘분·하지·추분·동지) 직달 누적 + 입사각 보정 히트맵.
// 계산량이 M2보다 커서 청크 비동기 처리 — 진행률을 상태바에 표시한다.

/** M4 오버레이 루트 — M3와 분리 */
const pvRoot = new THREE.Group();
viewer.scene.add(pvRoot);

const runPvBtn = document.getElementById("run-pv") as HTMLButtonElement;

runPvBtn.addEventListener("click", async () => {
  if (pvRunning) return;
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  syncAnalysisSettings();
  clearGroup(pvRoot);
  lastPv = null;
  // M5 오버레이와 같은 면에 겹치면 z-fighting — 한쪽만 표시
  if (lastPvEnergy) {
    lastPvEnergy = null;
    clearGroup(pvEnergyRoot);
    renderPvEnergySummary(null, "PV 상대평가 히트맵과 겹쳐 M5 결과를 지웠습니다.");
  }
  pvRunning = true;
  runPvBtn.disabled = true;
  setStatus("PV 분석 중… 0%");
  try {
    const t0 = performance.now();
    const result = await runPvAnalysis(project, (done, total) => {
      setStatus(`PV 분석 중… ${Math.round((done / total) * 100)}%`);
    });
    lastPv = result;
    const ms = performance.now() - t0;
    pvRoot.add(createPvOverlay(result.cells, result.results));
    renderPvSummary(
      result.summaries,
      `격자 ${result.cells.length}셀 × ${result.samplesPerDay}시각 × 4일 · ` +
        `${(ms / 1000).toFixed(1)}초 · 기준 최대 유효 ${result.maxEffective.toFixed(1)}h`,
    );
    setStatus(
      `PV 분석 완료 — ${result.cells.length}셀 (파랑=낮음 → 노랑 → 빨강=높음, 최대값 대비 %)`,
    );
  } catch (err) {
    setStatus(`PV 분석 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    pvRunning = false;
    runPvBtn.disabled = false;
  }
});

document.getElementById("clear-pv")!.addEventListener("click", () => {
  lastPv = null;
  clearGroup(pvRoot);
  renderPvSummary(null);
  setStatus("PV 결과를 지웠습니다.");
});

document.getElementById("export-pv-csv")!.addEventListener("click", () => {
  if (!lastPv) {
    setStatus("먼저 PV 분석을 실행하세요.");
    return;
  }
  // BOM을 붙여 엑셀에서 한글이 깨지지 않게 한다
  const csv =
    "\ufeff" + pvResultToCsv(lastPv, project.buildings, project.site.northAngle);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pv_relative_${project.analysis.date.slice(0, 4)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`CSV 내보냄 — ${lastPv.cells.length}셀 (좌표·법선·직달시간·유효량·상대효율)`);
});

// ---------- 태양광(PV) 절대평가 — TMY 기상데이터 (M5) ----------
// 모드 B 2단계: EPW 8,760시간 직달(레이캐스팅)+산란(등방성) → 연간 kWh/m².
// M4보다 시각 수가 ~18배라 진행률 필수 — 청크 비동기 처리.

/** M5 오버레이 루트 — M2·M4와 분리 */
const pvEnergyRoot = new THREE.Group();
viewer.scene.add(pvEnergyRoot);

const epwSelect = document.getElementById("epw-select") as HTMLSelectElement;
for (const { file, label } of EPW_FILES) {
  const opt = document.createElement("option");
  opt.value = file;
  opt.textContent = label;
  epwSelect.appendChild(opt);
}

/** 파일별 파싱 결과 캐시 — 재실행 시 fetch·파싱 생략 */
const epwCache = new Map<string, EpwData>();

async function loadEpw(file: string): Promise<EpwData> {
  const cached = epwCache.get(file);
  if (cached) return cached;
  const res = await fetch(`/data/${file}`);
  if (!res.ok) throw new Error(`EPW 파일을 불러올 수 없습니다: ${file}`);
  const epw = parseEpw(await res.text());
  epwCache.set(file, epw);
  // 검증용 콘솔 출력 (plan.md M5 검증 1 — 인천 1월 1일 12시 DNI=710 확인)
  const jan1 = epw.hours.find((h) => h.month === 1 && h.day === 1 && h.hour === 12);
  console.log(
    `[EPW] ${epw.location.name} (위도 ${epw.location.latitude}, 경도 ${epw.location.longitude})` +
      ` — 1월 1일 12시 DNI=${jan1?.dni} DHI=${jan1?.dhi} GHI=${jan1?.ghi} W/m²` +
      ` · 연간 GHI ${epw.annual.ghiKwh.toFixed(0)} kWh/m²`,
  );
  return epw;
}

const runPvAbsBtn = document.getElementById("run-pv-abs") as HTMLButtonElement;

runPvAbsBtn.addEventListener("click", async () => {
  if (pvEnergyRunning) return;
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오세요.");
    return;
  }
  syncAnalysisSettings();
  clearGroup(pvEnergyRoot);
  lastPvEnergy = null;
  // 같은 면의 M4 오버레이와 z-fighting — 한쪽만 표시
  if (lastPv) {
    lastPv = null;
    clearGroup(pvRoot);
    renderPvSummary(null, "M5 히트맵과 겹쳐 PV 상대평가 결과를 지웠습니다.");
  }
  pvEnergyRunning = true;
  runPvAbsBtn.disabled = true;
  const label =
    epwSelect.selectedOptions[0]?.textContent ?? epwSelect.value;
  try {
    setStatus(`M5 절대평가 — ${label} EPW 불러오는 중…`);
    const epw = await loadEpw(epwSelect.value);
    setStatus("M5 절대평가 계산 중… 0%");
    const t0 = performance.now();
    const result = await runPvEnergyAnalysis(project, epw, label, (done, total) => {
      setStatus(`M5 절대평가 계산 중… ${Math.round((done / total) * 100)}%`);
    });
    lastPvEnergy = result;
    const ms = performance.now() - t0;
    pvEnergyRoot.add(
      createPvEnergyOverlay(result.cells, result.results, result.maxKwh),
    );
    renderPvEnergySummary(
      result.summaries,
      `${label} TMY (관측소 ${result.station.name}, 위도 ${result.station.latitude}°)` +
        ` · 격자 ${result.cells.length}셀 × 레이캐스팅 ${result.rayHourCount}시각(고도>5°)` +
        ` · ${(ms / 1000).toFixed(1)}초 · 색상 스케일 0~${result.maxKwh.toFixed(0)} kWh/㎡·년`,
    );
    setStatus(
      `M5 절대평가 완료 — 최대 ${result.maxKwh.toFixed(0)} kWh/㎡·년 (파랑=0 → 빨강=최대)`,
    );
  } catch (err) {
    setStatus(`M5 절대평가 실패: ${(err as Error).message}`);
    console.error(err);
  } finally {
    pvEnergyRunning = false;
    runPvAbsBtn.disabled = false;
  }
});

document.getElementById("clear-pv-abs")!.addEventListener("click", () => {
  lastPvEnergy = null;
  clearGroup(pvEnergyRoot);
  renderPvEnergySummary(null);
  setStatus("M5 결과를 지웠습니다.");
});

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

function syncSetbackRules(): void {
  const r = project.analysis.setbackRules;
  r.northSetbackLowM = Math.max(0, parseFloat(northLowInput.value) || 1.5);
  r.northSetbackRatio = Math.max(0.1, parseFloat(northRatioInput.value) || 0.5);
  r.daylightRatio = Math.max(0.1, parseFloat(daylightRatioInput.value) || 2);
  r.daylightRoadParkRatio = Math.max(0.1, parseFloat(daylightRoadParkInput.value) || 2);
  r.spacingRatioWindow = Math.max(0.1, parseFloat(spacingWindowInput.value) || 0.5);
  r.spacingNoWindowM = Math.max(0, parseFloat(spacingNoWindowMInput.value) || 8);
  r.spacingSideM = Math.max(0, parseFloat(spacingSideMInput.value) || 4);
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
  northSetbackRoot.add(createNorthSetbackOverlay(lastNorthSetback));
  if (lastDaylight) daylightRoot.add(createDaylightOverlay(lastDaylight));
  if (lastSpacing) spacingRoot.add(createSpacingOverlay(lastSpacing));
  renderSetbackSummary(lastNorthSetback, lastDaylight, lastSpacing);
  refreshStatusDots(computeStatusMap());
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

runSunHoursBtn.addEventListener("click", async () => {
  if (sunHoursRunning) return;
  const adjCount = project.buildings.filter((b) => b.type === "인접건물").length;
  if (adjCount === 0) {
    setStatus("일조권 검토 대상(인접건물)이 없습니다. 먼저 DXF를 불러오세요.");
    return;
  }
  syncAnalysisSettings();
  project.analysis.sunHours.rule = sunHoursRuleSelect.value as SunHoursRule;
  project.analysis.sunHours.timeStep = Math.max(5, parseFloat(sunHoursStepInput.value) || 10);
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
    renderSunHoursSummary(
      result.summaries,
      ruleLabel,
      `격자 ${result.cells.length}셀 × ${result.samples.length}시각 · ${(ms / 1000).toFixed(1)}초`,
    );
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
  refreshStatusDots(computeStatusMap());
  setStatus("일조권 검토 결과를 지웠습니다.");
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
const WIND_SEED_COUNT = 20;

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
    const field = computeWindField(
      project.buildings,
      project.site,
      stats.prevailingDirDeg,
      WIND_GRID_M,
    );
    const streamlines = traceStreamlines(field, WIND_SEED_COUNT);
    lastWind = {
      windDir: stats.prevailingDirDeg,
      windSpeedMs: stats.meanSpeedMs,
      month,
      streamlines,
      shadowAreaM2: field.shadowAreaM2,
    };
    windGroup = createWindOverlay(lastWind, viewer.scene);
    renderWindSummary(
      lastWind,
      `${label} EPW ${stats.hours}시간 통계 · 격자 ${WIND_GRID_M}m · 2D 포텐셜 근사(CFD 아님)`,
    );
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
  setStatus("바람길 결과를 지웠습니다.");
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
  sunHoursMapGroup = createSunHoursMapOverlay(lastSunHoursMap, sunMapLegalCheckbox.checked);
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
  setStatus("일조시간 결과를 지웠습니다.");
});

// ---------- 세대수·엑셀 내보내기 (M6) ----------
// 주동 타입 템플릿 추가는 건물 라이브러리 패널(기본 샘플 템플릿)로 통합됨.

const siteAreaInput = document.getElementById("site-area") as HTMLInputElement;

/** 사이드 패널 하단 세대수 합계 + 건폐율·용적률 갱신 */
function updateSiteTotals(): void {
  project.site.siteAreaM2 = Math.max(0, parseFloat(siteAreaInput.value) || 0);
  renderSiteTotals(project.buildings, project.site.siteAreaM2);
}

siteAreaInput.addEventListener("change", updateSiteTotals);

document.getElementById("export-xlsx")!.addEventListener("click", () => {
  if (project.buildings.length === 0) {
    setStatus("먼저 DXF를 불러오거나 주동을 추가하세요.");
    return;
  }
  updateSiteTotals();
  const filename = exportXlsx(
    project,
    lastSunHours,
    lastNorthSetback,
    lastPv,
    lastPvEnergy,
    lastWind,
    lastSunHoursMap,
  );
  const t = siteUnitTotals(project.buildings);
  setStatus(
    `엑셀 내보냄 — ${filename} (배치 개요 · 일조권 · 정북사선 · PV · 바람길 · 일조시간, 총 ${t.total}세대)`,
  );
});

// ---------- DXF 배치도 내보내기 / .view 프로젝트 저장·불러오기 ----------

/** 텍스트를 파일로 다운로드 (DXF·.view 공용) */
function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("export-dxf")!.addEventListener("click", () => {
  if (!hasExportContent(project)) {
    setStatus("내보낼 배치가 없습니다 — 먼저 DXF를 불러오거나 주동을 배치하세요.");
    return;
  }
  const text = buildDxfText(project, sceneOrigin);
  const filename = `arch_view_배치도_${new Date().toISOString().slice(0, 10)}.dxf`;
  downloadText(text, filename, "application/dxf");
  const plan = project.buildings.filter((b) => b.type === "계획주동").length;
  const adj = project.buildings.length - plan;
  setStatus(
    `DXF 내보냄 — ${filename} (계획주동 ${plan}동 · 인접건물 ${adj}동 · ` +
      `오버레이 ${project.siteOverlays.length}개, mm 단위 R12)`,
  );
});

/** 현재 UI 입력값(위치·격자·사선 기준·일조권 설정·대지면적)을 project에 반영 */
function syncAllSettings(): void {
  syncAnalysisSettings();
  syncSetbackRules();
  project.analysis.sunHours.rule = sunHoursRuleSelect.value as SunHoursRule;
  project.analysis.sunHours.timeStep = Math.max(
    5,
    parseFloat(sunHoursStepInput.value) || 10,
  );
  project.site.siteAreaM2 = Math.max(0, parseFloat(siteAreaInput.value) || 0);
}

document.getElementById("save-view")!.addEventListener("click", () => {
  syncAllSettings();
  const json = serializeView(project, sceneOrigin, { dxfLoadSeq, sceneSeq });
  const filename = `arch_view_${new Date().toISOString().slice(0, 10)}.view`;
  downloadText(json, filename, "application/json");
  setStatus(
    `프로젝트 저장 — ${filename} (장면 ${project.buildings.length}동 · ` +
      `라이브러리 ${project.buildingLibrary.length}동 · 분석 설정 포함)`,
  );
});

/** .view에서 복원한 project 값을 UI 입력창에 되반영 */
function applyProjectToInputs(): void {
  latInput.value = String(project.site.latitude);
  lngInput.value = String(project.site.longitude);
  dateInput.value = project.analysis.date;
  gridInput.value = String(project.analysis.gridSize);
  siteAreaInput.value = String(project.site.siteAreaM2);
  fillSetbackInputs(project.analysis.setbackRules);
  sunHoursRuleSelect.value = project.analysis.sunHours.rule;
  sunHoursStepInput.value = String(project.analysis.sunHours.timeStep);
}

document.getElementById("view-file")!.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const d = deserializeView(await file.text());
    project.site = d.site;
    project.analysis = d.analysis;
    project.buildings = d.buildings;
    project.buildingLibrary = d.buildingLibrary;
    project.siteOverlays = d.siteOverlays;
    sceneOrigin = d.sceneOrigin;
    // id 카운터는 이어서 발급 — 복원된 건물과 새 건물의 id 충돌 방지
    dxfLoadSeq = Math.max(dxfLoadSeq, d.counters.dxfLoadSeq);
    sceneSeq = Math.max(sceneSeq, d.counters.sceneSeq);
    cloneOrigin.clear();
    libraryCheckedIds.clear();
    for (const b of project.buildingLibrary) libraryCheckedIds.add(b.id);
    selectedId = null;

    applyProjectToInputs();
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
    const saved = d.savedAt ? ` (저장 시각 ${d.savedAt.slice(0, 16).replace("T", " ")})` : "";
    setStatus(
      `${file.name} 불러옴 — 장면 ${project.buildings.length}동 · ` +
        `라이브러리 ${project.buildingLibrary.length}동 · 오버레이 ${project.siteOverlays.length}개${saved}`,
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
  const b = selectedPlanBuilding();
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
}
interface RotateState {
  building: Building;
  group: THREE.Group;
  /** 직전 포인터 각도 (라디안, DXF 평면) */
  lastAngle: number;
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

/** 포인터의 건물 중심 기준 각도 (라디안, DXF 평면 반시계) */
function pointerAngle(b: Building, hit: THREE.Vector3): number {
  const ctr = buildingCenter(b);
  // three z → DXF y 부호 반전
  return Math.atan2(-(hit.z - ctr.z), hit.x - ctr.x);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };

  // 1) 회전 그립 우선
  const planB = selectedPlanBuilding();
  if (planB && pickHandleGrip(e)) {
    const hit = groundHit(e);
    if (hit) {
      rotate = {
        building: planB,
        group: groups.get(planB.id)!,
        lastAngle: pointerAngle(planB, hit),
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
  if (!b || b.type !== "계획주동") return;
  const hit = groundHit(e);
  if (!hit) return;
  drag = {
    building: b,
    group,
    startHit: hit,
    startOffset: { ...b.offset },
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
    const hit = groundHit(e);
    if (!hit) return;
    const cur = pointerAngle(rotate.building, hit);
    // 증분 각도를 (-π, π]로 정규화해 누적 — 경계 점프 방지
    let delta = cur - rotate.lastAngle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    rotate.lastAngle = cur;
    rotate.building.offset.rotation += THREE.MathUtils.radToDeg(delta);
    applyOffset(rotate.group, rotate.building);
    updateRotationHandle();
    refreshOffsetInfo(rotate.building);
    invalidateAnalysis();
    updateSetbackChecks(); // M3 — 회전 중 실시간 갱신
    return;
  }
  if (!drag) return;
  const hit = groundHit(e);
  if (!hit) return;
  // three 좌표 → DXF 평면: dx = Δx, dy = -Δz
  drag.building.offset.dx = drag.startOffset.dx + (hit.x - drag.startHit.x);
  drag.building.offset.dy = drag.startOffset.dy - (hit.z - drag.startHit.z);
  applyOffset(drag.group, drag.building);
  updateRotationHandle();
  refreshOffsetInfo(drag.building);
  invalidateAnalysis();
  updateSetbackChecks(); // M3 — 드래그 중 실시간 갱신
});

canvas.addEventListener("pointerup", (e) => {
  if (rotate) {
    setStatus(
      `${rotate.building.name} 회전: ${rotate.building.offset.rotation.toFixed(1)}°`,
    );
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
    setStatus(
      `${drag.building.name} 이동: (${drag.building.offset.dx.toFixed(1)}, ${drag.building.offset.dy.toFixed(1)})m`,
    );
    drag = null;
    viewer.controls.enabled = true;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }
  // 드래그가 아닌 짧은 클릭이면 선택 처리
  if (
    downPos &&
    Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) < 4
  ) {
    const group = pickBuilding(e);
    selectBuilding(group ? (group.userData.buildingId as string) : null);
  }
  downPos = null;
});

refreshList();
refreshLibraryList();
syncAnalysisSettings();
updateSunFromSlider();
updateSetbackChecks();

// 개발용 디버그 훅
if (import.meta.env.DEV) {
  (window as any).__app = {
    project,
    viewer,
    groups,
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
    getLastPv: () => lastPv,
    // M5
    getLastPvEnergy: () => lastPvEnergy,
    loadEpw,
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
