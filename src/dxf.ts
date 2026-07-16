import DxfParser from "dxf-parser";
import { FixedLwpolylineParser } from "./dxf-lwpolyline";
import { defaultUnitMix } from "./massing";
import { segmentsCoincide, WINDOW_MATCH_TOLERANCE } from "./windows";
import type { Building, BuildingType, OverlayLayer, OverlayLine, Point2 } from "./types";

// data/DXF_RULES.md DXF 레이어 규약
export const LAYER_PLAN_PREFIX = "PLAN_BLDG";
export const LAYER_ADJ_PREFIX = "ADJ_BLDG";
export const LAYER_PLAN_WIN = "PLAN_WIN";
export const LAYER_ADJ_WIN = "ADJ_WIN";
const OVERLAY_LAYERS: OverlayLayer[] = [
  "SITE_BOUNDARY",
  "ADJ_BOUNDARY",
  "ROAD_CL",
  "PARK_BOUNDARY",
  "CONTOUR",
];

/** 레이어명 접미사로 층수 지정: PLAN_BLDG_15F, ADJ_BLDG_5F 등 (대소문자 무관) */
const FLOOR_SUFFIX_RE = /_(\d+)F$/i;
/**
 * 권장 규약: PLAN_<타입문자>_<번호>(_<층수>F) — 예: PLAN_A_1, PLAN_B_2, PLAN_A_3_20F.
 * 타입 문자(A/B/…)는 사용자가 타워형·판상형 등을 임의로 구분하는 용도이고,
 * 층수 접미사가 없으면 기본 15층(UI에서 조정). 건물명은 "계획주동_A_1" 형태가 된다.
 */
const PLAN_TYPE_RE = /^PLAN_([A-Z]+)_(\d+)(?:_(\d+)F)?$/;
const ADJ_TYPE_RE = /^ADJ_([A-Z]+)_(\d+)(?:_(\d+)F)?$/;
const DEFAULT_FLOORS_PLAN = 15;
const DEFAULT_FLOORS_ADJ = 5;

/** 도면 단위 선택 — "auto"는 DXF HEADER의 $INSUNITS를 읽고, 없으면 mm으로 가정(한국 실무 기본값) */
export type UnitMode = "auto" | "mm" | "m";

export type UnitSource = "header-mm" | "header-m" | "default-mm" | "manual-mm" | "manual-m";

export interface DxfLoadResult {
  buildings: Building[];
  overlays: OverlayLine[];
  warnings: string[];
  /** 실제 적용된 mm→m(또는 m→m) 변환 배율 */
  unitScale: number;
  /** 배율을 어떻게 정했는지 — 상태 표시용 */
  unitSource: UnitSource;
}

interface RawPolyline {
  layer: string;
  vertices: Point2[];
  closed: boolean;
}

export interface BuildingLayerMatch {
  isPlan: boolean;
  floors: number | null;
  /** PLAN_A_1 규약의 타입 문자·번호 — 구 규약(PLAN_BLDG)이면 null */
  typeTag: string | null;
  typeNum: number | null;
}

/**
 * 레이어명에서 건물 종류(PLAN/ADJ)·타입태그·층수를 판별. 매칭 안 되면 null.
 * 지원 규약(대소문자 무관):
 *  - 권장: PLAN_<타입문자>_<번호>(_<층수>F) / ADJ_<타입문자>_<번호>(_<층수>F)
 *  - 구버전 호환: PLAN_BLDG(_<층수>F) / ADJ_BLDG(_<층수>F)
 * ⚠️ 구버전 규약을 먼저 검사한다 — PLAN_BLDG_15F는 타입 규약 정규식과 겹치지 않지만
 * (BLDG 뒤 "_15F"는 타입번호 아님) 의미가 명확하도록 순서를 고정.
 */
function matchBuildingLayer(layer: string): BuildingLayerMatch | null {
  const upper = layer.toUpperCase();

  // 구버전: PLAN_BLDG(_nF) / ADJ_BLDG(_nF)
  const m = upper.match(FLOOR_SUFFIX_RE);
  const base = m ? upper.slice(0, m.index) : upper;
  const floors = m ? parseInt(m[1], 10) : null;
  if (base === LAYER_PLAN_PREFIX)
    return { isPlan: true, floors, typeTag: null, typeNum: null };
  if (base === LAYER_ADJ_PREFIX)
    return { isPlan: false, floors, typeTag: null, typeNum: null };

  // 권장: PLAN_<타입>_<번호>(_<층수>F)
  const pm = upper.match(PLAN_TYPE_RE);
  if (pm) {
    return {
      isPlan: true,
      floors: pm[3] ? parseInt(pm[3], 10) : null,
      typeTag: pm[1],
      typeNum: parseInt(pm[2], 10),
    };
  }
  const am = upper.match(ADJ_TYPE_RE);
  if (am) {
    return {
      isPlan: false,
      floors: am[3] ? parseInt(am[3], 10) : null,
      typeTag: am[1],
      typeNum: parseInt(am[2], 10),
    };
  }
  return null;
}

/**
 * DXF HEADER의 $INSUNITS로 도면 단위를 판별한다.
 * 4=mm, 6=m. 그 외 값이거나 HEADER가 없으면 한국 실무 기본값인 mm으로 가정한다.
 * (AutoCAD 실무 도면은 거의 전부 mm 단위 — 사용자에게 재저장을 요구하지 않기 위한 기본값)
 */
function detectUnitScale(
  dxf: { header?: Record<string, unknown> },
  mode: UnitMode,
): { scale: number; source: UnitSource } {
  if (mode === "mm") return { scale: 0.001, source: "manual-mm" };
  if (mode === "m") return { scale: 1, source: "manual-m" };
  const insUnits = dxf.header?.["$INSUNITS"];
  if (insUnits === 6) return { scale: 1, source: "header-m" };
  if (insUnits === 4) return { scale: 0.001, source: "header-mm" };
  return { scale: 0.001, source: "default-mm" };
}

export function unitSourceLabel(source: UnitSource): string {
  switch (source) {
    case "header-mm":
      return "자동감지: mm ($INSUNITS=4)";
    case "header-m":
      return "자동감지: m ($INSUNITS=6)";
    case "default-mm":
      return "자동감지 실패 → mm 기본값 적용";
    case "manual-mm":
      return "수동 지정: mm";
    case "manual-m":
      return "수동 지정: m";
  }
}

/**
 * DXF 텍스트에서 data/DXF_RULES.md 규약의 전체 레이어를 추출한다.
 * - PLAN_BLDG(_<n>F) / ADJ_BLDG(_<n>F): Building으로 변환 (층수는 레이어 접미사, 없으면 기본값)
 * - SITE_BOUNDARY / ADJ_BOUNDARY / ROAD_CL / PARK_BOUNDARY / CONTOUR: 참고용 오버레이 선
 * - PLAN_WIN / ADJ_WIN: 창이 있는 벽면 표시선 — footprint 에지와 좌표 일치로 매칭
 * @param unitMode "auto"(기본, $INSUNITS 자동감지) | "mm" | "m" 수동 고정
 */
export function parseDxfBuildings(
  text: string,
  unitMode: UnitMode = "auto",
): DxfLoadResult {
  const parser = new DxfParser();
  // dxf-parser 내장 LWPOLYLINE 파서는 AC1027+(AutoCAD 2013 형식)의 vertex ID
  // (그룹코드 91)를 만나면 버텍스 파싱을 중단해 첫 버텍스만 남는다 — 교체본 등록
  parser.registerEntityHandler(FixedLwpolylineParser as any);
  const dxf = parser.parseSync(text);
  const warnings: string[] = [];

  if (!dxf || !dxf.entities) {
    throw new Error("DXF 파싱 결과에 엔티티가 없습니다.");
  }

  const { scale: unitScale, source: unitSource } = detectUnitScale(dxf, unitMode);

  const polylines: RawPolyline[] = [];
  const overlays: OverlayLine[] = [];
  const planWinSegments: [Point2, Point2][] = [];
  const adjWinSegments: [Point2, Point2][] = [];

  for (const entity of dxf.entities as any[]) {
    if (
      entity.type !== "LWPOLYLINE" &&
      entity.type !== "POLYLINE" &&
      entity.type !== "LINE"
    )
      continue;
    const layer: string = entity.layer ?? "";
    const upper = layer.toUpperCase();

    // AutoCAD MIRROR는 좌표를 바꾸는 대신 extrusion 벡터(그룹코드 210/220/230)를
    // (0,0,-1)로 뒤집어 저장하기도 한다 — 이때 저장된 x는 OCS 좌표라 부호를 반전해야
    // 도면상 실제(WCS) 위치가 된다. 무시하면 미러된 창면/건물이 footprint와 어긋난다.
    // (LWPOLYLINE은 extrusionDirectionX/Y/Z 스칼라, LINE/POLYLINE은 extrusionDirection 점)
    const extrusionZ: number =
      entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
    const xSign = extrusionZ < 0 ? -1 : 1;

    const vertices: Point2[] = (entity.vertices ?? []).map((v: any) => ({
      x: v.x * xSign * unitScale,
      y: v.y * unitScale,
    }));

    if (upper === LAYER_PLAN_WIN || upper === LAYER_ADJ_WIN) {
      if (vertices.length < 2) {
        warnings.push(`${layer} 레이어에 꼭짓점 2개 미만 선분 무시`);
        continue;
      }
      let closed = entity.shape === true || (entity.flag & 1) === 1;
      const first = vertices[0];
      const last = vertices[vertices.length - 1];
      if (
        vertices.length >= 3 &&
        Math.abs(first.x - last.x) < 1e-9 &&
        Math.abs(first.y - last.y) < 1e-9
      ) {
        vertices.pop();
        closed = true;
      }
      const bucket = upper === LAYER_PLAN_WIN ? planWinSegments : adjWinSegments;
      for (let i = 0; i < vertices.length - 1; i++) {
        bucket.push([vertices[i], vertices[i + 1]]);
      }
      // closed 폴리라인은 마지막→첫 버텍스 에지도 창면 후보에 포함
      if (closed && vertices.length >= 3) {
        bucket.push([vertices[vertices.length - 1], vertices[0]]);
      }
      continue;
    }

    const overlayLayer = OVERLAY_LAYERS.find((l) => l === upper);
    if (overlayLayer) {
      if (vertices.length < 2) {
        warnings.push(`${layer} 레이어에 꼭짓점 2개 미만 선분 무시`);
        continue;
      }
      let closed = entity.shape === true || (entity.flag & 1) === 1;
      const a = vertices[0];
      const b = vertices[vertices.length - 1];
      if (
        vertices.length >= 3 &&
        Math.abs(a.x - b.x) < 1e-9 &&
        Math.abs(a.y - b.y) < 1e-9
      ) {
        vertices.pop();
        closed = true;
      }
      overlays.push({ layer: overlayLayer, points: vertices, closed });
      continue;
    }

    if (entity.type === "LINE") continue; // 건물 레이어에는 LINE 미지원

    const bldgMatch = matchBuildingLayer(layer);
    if (!bldgMatch) continue;

    // 마지막 점이 첫 점과 같으면 중복 제거
    if (vertices.length >= 2) {
      const a = vertices[0];
      const b = vertices[vertices.length - 1];
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
        vertices.pop();
      }
    }
    if (vertices.length < 3) {
      warnings.push(`${layer} 레이어에 꼭짓점 3개 미만 폴리라인 무시`);
      continue;
    }
    const closed = entity.shape === true || (entity.flag & 1) === 1;
    if (!closed) {
      warnings.push(
        `${layer} 레이어에 닫히지 않은 폴리라인 발견 — 닫힌 것으로 간주하고 불러옴`,
      );
    }
    polylines.push({ layer: upper, vertices, closed });
  }

  if (
    polylines.length === 0 &&
    overlays.length === 0 &&
    planWinSegments.length === 0 &&
    adjWinSegments.length === 0
  ) {
    throw new Error(
      `알려진 레이어를 찾지 못했습니다 — PLAN_<타입>_<번호>(예: PLAN_A_1) / ADJ_<타입>_<번호> / ` +
        `${LAYER_PLAN_PREFIX}(_<n>F) / ${LAYER_ADJ_PREFIX}(_<n>F) / ` +
        `${LAYER_PLAN_WIN} / ${LAYER_ADJ_WIN} / SITE_BOUNDARY / ADJ_BOUNDARY / ROAD_CL / PARK_BOUNDARY / CONTOUR. ` +
        `레이어 이름과 폴리라인 타입(LWPOLYLINE)을 확인하세요.`,
    );
  }
  // 건물 없이 오버레이(대지경계 등)만 있는 파일도 허용 — data/DXF_RULES.md 4장 "파일 분리" 워크플로

  const buildings: Building[] = [];
  let planCount = 0;
  let adjCount = 0;
  const planTotal = polylines.filter(
    (p) => matchBuildingLayer(p.layer)?.isPlan,
  ).length;
  /** 같은 레이어(같은 타입태그)에 폴리라인이 여러 개면 이름 뒤에 -2, -3… 을 붙여 구분 */
  const nameCount = new Map<string, number>();
  for (const pl of polylines) {
    const m = matchBuildingLayer(pl.layer)!;
    const isPlan = m.isPlan;
    const type: BuildingType = isPlan ? "계획주동" : "인접건물";
    const floors = m.floors ?? (isPlan ? DEFAULT_FLOORS_PLAN : DEFAULT_FLOORS_ADJ);
    const unitsPerFloor = isPlan ? 4 : 0;
    let name: string;
    if (m.typeTag !== null) {
      // 권장 규약: PLAN_A_1 → "계획주동_A_1" (라이브러리·목록에서 타입·번호로 바로 식별)
      const base = `${type}_${m.typeTag}_${m.typeNum}`;
      const n = (nameCount.get(base) ?? 0) + 1;
      nameCount.set(base, n);
      name = n > 1 ? `${base}-${n}` : base;
    } else {
      name = isPlan
        ? `계획주동${++planCount > 1 || planTotal > 1 ? " " + planCount : ""}`
        : `인접건물 ${String.fromCharCode(64 + ++adjCount)}`; // A, B, C...
    }
    buildings.push({
      id: `bldg-${buildings.length + 1}`,
      name,
      type,
      // M6: DXF 폴리곤은 custom — 계획주동은 기본 세대구성으로 세대수 산출
      massType: "custom",
      footprint: pl.vertices,
      floors,
      floorHeight: isPlan ? 2.8 : 3.0,
      pilotiFloors: 0,
      unitsPerFloor,
      segments: 1,
      unitMix: isPlan ? defaultUnitMix(unitsPerFloor) : [],
      offset: { dx: 0, dy: 0, rotation: 0 },
      // PV(M4/M5) 잠재량 분석 대상 = 계획주동(태양광은 우리가 짓는 건물의 지붕·창없는 벽에 검토)
      analysisTarget: isPlan,
      mirroredH: false,
      mirroredV: false,
      windowSegments: [],
    });
  }

  // PLAN_WIN/ADJ_WIN 선분을 footprint 에지와 좌표 일치(허용오차 0.1m)로 매칭.
  // 후보 선분 기준으로 순회해 여러 건물에 걸쳐 검색 — 다른 건물에 이미 매칭된 선분을
  // "미매칭"으로 잘못 세지 않도록 건물 기준이 아닌 선분 기준으로 루프를 돈다.
  let unmatchedWin = 0;
  const matchWinLayer = (candidates: [Point2, Point2][], isPlan: boolean) => {
    const targets = buildings.filter(
      (b) => (b.type === "계획주동") === isPlan,
    );
    for (const [wa, wb] of candidates) {
      let matched = false;
      for (const b of targets) {
        const n = b.footprint.length;
        for (let i = 0; i < n; i++) {
          const p1 = b.footprint[i];
          const p2 = b.footprint[(i + 1) % n];
          if (segmentsCoincide(p1, p2, wa, wb, WINDOW_MATCH_TOLERANCE)) {
            b.windowSegments.push([wa, wb]);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) unmatchedWin++;
    }
  };
  matchWinLayer(planWinSegments, true);
  matchWinLayer(adjWinSegments, false);
  if (unmatchedWin > 0) {
    warnings.push(
      `${LAYER_PLAN_WIN}/${LAYER_ADJ_WIN} 선분 ${unmatchedWin}개가 어떤 건물 외곽선과도 ` +
        `일치하지 않아 무시됨 (허용오차 ${WINDOW_MATCH_TOLERANCE}m — 좌표를 정확히 맞춰 그려주세요)`,
    );
  }

  return { buildings, overlays, warnings, unitScale, unitSource };
}

/**
 * 건물·오버레이 전체의 바운딩 박스 중심을 구한다 (카메라·조작 편의를 위한 원점 보정용).
 * 여러 DXF를 병합해서 불러올 때는 최초 1회만 계산해 재사용해야 서로 어긋나지 않는다.
 */
export function computeRecenterOffset(
  buildings: Building[],
  overlays: OverlayLine[],
): Point2 {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const consider = (p: Point2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const b of buildings) for (const p of b.footprint) consider(p);
  for (const o of overlays) for (const p of o.points) consider(p);
  if (!isFinite(minX)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** 지정한 offset만큼 건물(footprint+windowSegments)·오버레이 좌표를 평행이동 (원점 보정 적용) */
export function applyRecenterOffset(
  offset: Point2,
  buildings: Building[],
  overlays: OverlayLine[],
): void {
  const shift = (p: Point2): Point2 => ({ x: p.x - offset.x, y: p.y - offset.y });
  for (const b of buildings) {
    b.footprint = b.footprint.map(shift);
    b.windowSegments = b.windowSegments.map(([a, c]) => [shift(a), shift(c)]);
  }
  for (const o of overlays) {
    o.points = o.points.map(shift);
  }
}
