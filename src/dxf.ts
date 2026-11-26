import DxfParser from "dxf-parser";
import { FixedLwpolylineParser } from "./dxf-lwpolyline";
import { pointInPolygon, signedArea } from "./geom2d";
import { defaultUnitMix, planTypeOf } from "./massing";
import { extractContourPoints, isContourLayer } from "./terrain";
import { unionAdjacentPolygons } from "./polyunion";
import { segmentLiesOnEdge, WINDOW_MATCH_TOLERANCE } from "./windows";
import type {
  Building,
  BuildingType,
  FacilityUse,
  OverlayLayer,
  OverlayLine,
  Point2,
  Point3,
} from "./types";

// data/DXF_RULES.md DXF 레이어 규약
export const LAYER_PLAN_PREFIX = "PLAN_BLDG";
export const LAYER_ADJ_PREFIX = "ADJ_BLDG";
export const LAYER_PLAN_WIN = "PLAN_WIN";
export const LAYER_ADJ_WIN = "ADJ_WIN";
// CONTOUR(_<고도>)는 M7 지형 파싱(terrain.ts)에서 3D 점과 함께 별도 처리한다
const OVERLAY_LAYERS: OverlayLayer[] = [
  "SITE_BOUNDARY",
  "ADJ_BOUNDARY",
  "ROAD_CL",
  "PARK_BOUNDARY",
  "ROAD_AREA",
  "PARCEL",
];

/**
 * 평형별 전용공간 레이어 — UNIT_<전용면적>(예: UNIT_59, UNIT_84). 주동 외곽선 안에 세대마다
 * 닫힌 폴리라인 하나씩 그리면, 동별로 개수를 세어 "평형별 층당 세대수"로 넣는다.
 */
const UNIT_LAYER_RE = /^UNIT_(\d+(?:\.\d+)?)$/;
/**
 * 코어 레이어 — 세대 유니트(UNIT_<평형>)와 코어를 벽을 맞대 그리면, 주동 외곽선(PLAN_)을 따로
 * 그리지 않아도 맞댄 덩어리마다 계획주동 하나로 합쳐 불러온다.
 */
export const LAYER_CORE = "PLAN_CORE";
const CORE_LAYER_RE = /^(PLAN_)?CORE$/;

/** 레이어명 접미사로 층수 지정: PLAN_BLDG_15F, ADJ_BLDG_5F 등 (대소문자 무관) */
const FLOOR_SUFFIX_RE = /_(\d+)F$/i;
/**
 * 권장 규약: PLAN_<타입문자>_<번호>(_<층수>F) — 예: PLAN_A_1, PLAN_B_2, PLAN_A_3_20F.
 * 타입 문자(A/B/…)는 사용자가 타워형·판상형 등을 임의로 구분하는 용도이고,
 * 층수 접미사·층수 문자가 없으면 기본 1층(UI에서 입력). 건물명은 "계획주동_A_1" 형태가 된다.
 */
const PLAN_TYPE_RE = /^PLAN_([A-Z]+)_(\d+)(?:_(\d+)F)?$/;
const ADJ_TYPE_RE = /^ADJ_([A-Z]+)_(\d+)(?:_(\d+)F)?$/;
/**
 * 층수 정보(레이어 접미사 _nF · 건물 안 층수 문자)가 없을 때의 기본값.
 * 도면에서 배치를 통째로 불러온 뒤 동마다 층수를 직접 입력하는 흐름이라 1개층으로 둔다
 * (예전 기본값 15층/5층은 확인 안 된 층수가 그럴듯한 값으로 섞여 들어가는 문제가 있었다).
 */
export const DEFAULT_FLOORS_PLAN = 1;
export const DEFAULT_FLOORS_ADJ = 1;

/** 층수 문자 전용 레이어 — 건물 외곽선 안에 "5F"·"5층"·"5"로 적는다 */
export const LAYER_FLOOR_TEXT = "BLDG_FLOORS";

/**
 * 층수 문자 해석 — "5F", "5 F", "5층", "5"를 5로. 그 외(지하 "B1", "5F/2F" 등)는 null.
 * MTEXT 서식 코드({\fArial;5F}, \P 줄바꿈 등)는 걷어낸 뒤 판정한다.
 */
export function parseFloorText(raw: string): number | null {
  const plain = raw
    .replace(/\\[A-Za-z][^;\\]*;/g, "") // \fArial|b0; \H2.5; 같은 서식
    .replace(/\\P/g, " ")
    .replace(/[{}]/g, "")
    .trim();
  const m = plain.match(/^(\d{1,3})\s*(?:F|층)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 200 ? n : null;
}

/** 시설 용도 문자 전용 레이어 — 건물 외곽선 안에 "유치원"·"초등학교"·"교회"로 적는다 */
export const LAYER_USE_TEXT = "BLDG_USE";
/** 동 이름 문자 — 건물 외곽선 안에 "101동"처럼 적으면 그 이름으로 불러온다 */
export const LAYER_NAME_TEXT = "BLDG_NAME";

/** 용도 문자 해석 — 한글·영문 모두. 그 외는 null */
export function parseUseText(raw: string): FacilityUse | null {
  const plain = raw
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/\\P/g, " ")
    .replace(/[{}\s]/g, "")
    .toUpperCase();
  if (/유치원|어린이집|KINDER/.test(plain)) return "kindergarten";
  if (/초등학교|중학교|고등학교|학교|SCHOOL/.test(plain)) return "school";
  if (/교회|성당|사찰|예배|CHURCH/.test(plain)) return "church";
  return null;
}

/** 엑셀 열 이름 방식 1→A, 26→Z, 27→AA — 인접건물이 26동을 넘어도 이름이 깨지지 않게 */
export function letterSeq(n: number): string {
  let s = "";
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

/** 도면 단위 선택 — "auto"는 DXF HEADER의 $INSUNITS를 읽고, 없으면 mm으로 가정(한국 실무 기본값) */
export type UnitMode = "auto" | "mm" | "m";

export type UnitSource = "header-mm" | "header-m" | "default-mm" | "manual-mm" | "manual-m";

export interface DxfLoadResult {
  buildings: Building[];
  overlays: OverlayLine[];
  /** M7 지형 — CONTOUR 레이어 등고선 꼭짓점(m, 고도 z 포함). 없으면 빈 배열(평지 모드) */
  contourPoints: Point3[];
  warnings: string[];
  /** 실제 적용된 mm→m(또는 m→m) 변환 배율 */
  unitScale: number;
  /** 건물 안 층수 문자로 층수가 정해진 동 수 */
  floorsFromText: number;
  /** BLDG_USE 용도 문자로 시설 용도가 정해진 동 수 */
  usesFromText: number;
  /** UNIT_<평형> 전용공간으로 세대 구성이 정해진 동 수 */
  unitsFromDrawing: number;
  /** 배율을 어떻게 정했는지 — 상태 표시용 */
  unitSource: UnitSource;
  /** 위치가 있는 확인 필요 항목 — 진단표에서 눌러 그 건물·지점으로 이동 */
  issues: DxfIssue[];
}

/** 불러오기 확인 필요 항목 — building(해당 건물) 또는 point(도면 좌표 m, 원점 이동 전) */
export interface DxfIssue {
  kind: "층수 충돌" | "층수 문자 밖" | "창선 벽 밖" | "유니트 주동 밖" | "동 이름 밖" | "형상 다름" | "층수 없음";
  message: string;
  building?: Building;
  point?: Point2;
}

interface RawPolyline {
  layer: string;
  vertices: Point2[];
  closed: boolean;
  /** 세대 유니트+코어로 만든 동의 평형 구성 타입 (예: "59x2+84x2") */
  planType?: string;
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
 * footprint 형상 시그니처 — 회전·이동·**미러에 불변**(변 길이 다중집합 + 면적).
 * 같은 타입 레이어에 서로 다른 형상의 주동이 섞여 그려졌는지 찾는 용도.
 * 미러 복사본은 같은 타입으로 봐야 하므로 winding(부호)은 쓰지 않고 면적 절댓값만 쓴다.
 */
function shapeSignature(pts: Point2[]): string {
  const lens = pts
    .map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return Math.hypot(q.x - p.x, q.y - p.y);
    })
    .map((v) => v.toFixed(2))
    .sort();
  return `${Math.abs(signedArea(pts)).toFixed(1)}|${lens.join(",")}`;
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
 * 같은 레이어 안에서 **벽을 맞댄** 폴리곤들을 한 동으로 합친다.
 *
 * 실무 동평면은 세대 유니트와 코어를 각각 닫힌 폴리라인으로 그려 벽을 맞대는 경우가 많다.
 * 그대로 읽으면 한 동이 유니트 수만큼 쪼개지므로 합쳐 준다.
 *
 * ⚠️ 판별 기준은 레이어가 아니라 **엣지 공유**다. "같은 레이어에 떨어진 폴리곤 여러 개"는
 * 같은 타입 주동을 여러 동 배치한다는 기존 규약이므로 절대 합치면 안 된다.
 */
function mergeAdjacentBuildingPolylines(
  polylines: RawPolyline[],
  warnings: string[],
  /** 세대 유니트(UNIT_) 중심점 — 이것이 든 외곽선은 "독립된 동"이라 서로 합치지 않는다 */
  unitCentroids: Point2[] = [],
): RawPolyline[] {
  const order: string[] = [];
  const byLayer = new Map<string, RawPolyline[]>();
  for (const pl of polylines) {
    const list = byLayer.get(pl.layer);
    if (list) {
      list.push(pl);
    } else {
      byLayer.set(pl.layer, [pl]);
      order.push(pl.layer);
    }
  }

  const out: RawPolyline[] = [];
  for (const layer of order) {
    const list = byLayer.get(layer)!;
    // 합치기는 계획주동(세대·코어 조각)만 — 주변 건물은 벽을 맞대도 서로 다른 건물이라
    // 합치면 층수 문자가 섞인다(도시 블록의 연립 건물들)
    if (list.length <= 1 || !layer.toUpperCase().startsWith("PLAN")) {
      out.push(...list);
      continue;
    }
    const result = splitAttachedBodies(list.map((p) => p.vertices), unitCentroids, layer, warnings);
    for (const f of result.failures) warnings.push(`${layer} — ${f}`);

    const mergedGroups = result.sources.filter((s) => s.length > 1);
    if (mergedGroups.length > 0) {
      const parts = mergedGroups.reduce((n, s) => n + s.length, 0);
      warnings.push(
        `${layer} 레이어에서 벽을 맞댄 폴리곤 ${parts}개를 ${mergedGroups.length}개 동으로 ` +
          `합쳤습니다 (세대 유니트·코어를 따로 그린 동평면으로 판단). ` +
          `떨어져 있는 폴리곤은 기존대로 각각 별개 동으로 불러옵니다.`,
      );
    }
    for (const poly of result.polygons) {
      out.push({ layer, vertices: poly, closed: true });
    }
  }
  return out;
}

/**
 * 벽 맞댄 폴리곤 합치기 — 단, 세대 유니트(UNIT_)가 든 외곽선(= 동 하나 전체를 그린 것)이 둘 이상
 * 맞붙은 덩어리는 **동별로 나눈다**(붙어 있는 두 동 — 동마다 층수를 따로 줄 수 있어야 한다).
 * 유니트가 없는 조각(코어 돌출부 등)은 벽을 맞댄 동에 붙인다. 유니트 정보가 없으면 기존처럼 전부 합친다.
 */
function splitAttachedBodies(
  polys: Point2[][],
  unitCentroids: Point2[],
  layer: string,
  warnings: string[],
): { polygons: Point2[][]; sources: number[][]; failures: string[] } {
  const whole = unionAdjacentPolygons(polys);
  if (unitCentroids.length === 0) return whole;
  const isBody = polys.map((p) => unitCentroids.some((c) => pointInPolygon(c.x, c.y, p)));
  const out = { polygons: [] as Point2[][], sources: [] as number[][], failures: [...whole.failures] };
  let split = 0;
  whole.sources.forEach((src, gi) => {
    const bodies = src.filter((k) => isBody[k]);
    if (bodies.length <= 1) {
      out.polygons.push(whole.polygons[gi]);
      out.sources.push(src);
      return;
    }
    // 동마다 따로: 유니트 없는 조각은 벽을 맞댄 동(또는 이미 붙은 조각)에 붙인다
    const sets = bodies.map((b) => [b]);
    let rest = src.filter((k) => !isBody[k]);
    for (let changed = true; changed && rest.length; ) {
      changed = false;
      rest = rest.filter((k) => {
        const s = sets.find((set) => unionAdjacentPolygons(set.concat(k).map((i) => polys[i])).polygons.length === 1);
        if (!s) return true;
        s.push(k);
        changed = true;
        return false;
      });
    }
    for (const k of rest) sets.push([k]); // 어느 동에도 안 붙는 조각은 따로
    for (const set of sets) {
      const u = unionAdjacentPolygons(set.map((i) => polys[i]));
      u.polygons.forEach((poly, j) => {
        out.polygons.push(poly);
        out.sources.push(u.sources[j].map((x) => set[x]));
      });
    }
    split += bodies.length;
  });
  if (split > 0) {
    warnings.push(
      `${layer} 레이어에서 벽을 맞댄 동 ${split}개를 동별로 나눴습니다 (세대 유니트가 든 외곽선 = 독립된 동 — 층수를 따로 줄 수 있음)`,
    );
  }
  return out;
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
  const contourPoints: Point3[] = [];
  const planWinSegments: [Point2, Point2][] = [];
  const adjWinSegments: [Point2, Point2][] = [];

  /** 평형별 전용공간 (도면 좌표 m) — 건물이 정해진 뒤 외곽선 안에 든 것을 세어 세대 구성으로 쓴다 */
  const unitPolys: { unitType: string; points: Point2[] }[] = [];
  /** 코어 폴리곤 (PLAN_CORE) — 유니트와 합쳐 주동 외곽선을 만든다 */
  const corePolys: Point2[][] = [];
  /** 층수 문자 후보 (도면 좌표 m) — 건물이 정해진 뒤 외곽선 안에 든 것을 찾아 층수로 쓴다 */
  const floorTexts: { x: number; y: number; floors: number; layer: string }[] = [];
  /** 시설 용도 문자 (BLDG_USE) */
  const useTexts: { x: number; y: number; use: FacilityUse }[] = [];
  const issues: DxfIssue[] = [];
  /** 동 이름 문자 (BLDG_NAME) */
  const nameTexts: { x: number; y: number; name: string }[] = [];
  /** 도면 단위가 mm인데 고도를 m로 적은 등고선 수 — 알림용 */
  const contourStats = { meterZ: 0, lines: 0 };

  // 범례(안내) 틀 — 밑줄(_)로 시작하는 레이어의 닫힌 폴리라인 안에 통째로 든 객체는 견본이라 읽지 않는다.
  // 견본선을 실제 레이어(ADJ_WIN·PARCEL 등)에 그려 두어야 CAD에서 레이어 이름이 범례와 맞고
  // 특성 일치(MATCHPROP)로 옮겨도 올바른 레이어가 되기 때문.
  const noteBoxes = collectNoteFrames(dxf.entities as any[], unitScale);
  const inNote = (pts: Point2[]) =>
    noteBoxes.length > 0 &&
    pts.length > 0 &&
    noteBoxes.some((b) => pts.every((p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1));
  let noteSkipped = 0;

  for (const entity of dxf.entities as any[]) {
    if (String(entity.layer ?? "").startsWith("_")) continue; // 안내 레이어 자체
    if (entity.type === "TEXT" || entity.type === "MTEXT") {
      const textLayer = String(entity.layer ?? "").toUpperCase();
      const anchor = textAnchor(entity);
      if (anchor && noteBoxes.length) {
        const ez0: number = entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
        if (inNote([{ x: anchor.x * (ez0 < 0 ? -1 : 1) * unitScale, y: anchor.y * unitScale }])) {
          noteSkipped++;
          continue;
        }
      }
      if (textLayer === LAYER_NAME_TEXT) {
        const raw = String(entity.text ?? "").replace(/\\P/g, " ").replace(/[{}]|\\[A-Za-z][^;]*;/g, "").trim();
        if (raw && anchor) {
          const ez: number = entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
          nameTexts.push({ x: anchor.x * (ez < 0 ? -1 : 1) * unitScale, y: anchor.y * unitScale, name: raw });
        }
        continue;
      }
      if (textLayer === LAYER_USE_TEXT) {
        const use = parseUseText(String(entity.text ?? ""));
        const pt = anchor;
        if (use && pt) {
          const ez: number = entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
          useTexts.push({ x: pt.x * (ez < 0 ? -1 : 1) * unitScale, y: pt.y * unitScale, use });
        }
        continue;
      }
      const floors = parseFloorText(String(entity.text ?? ""));
      if (floors === null) continue;
      // TEXT는 정렬 지정(72/73)이 있으면 두 번째 정렬점(11)이 실제 기준 위치다
      const pt = anchor;
      if (!pt) continue;
      const ez: number = entity.extrusionDirectionZ ?? entity.extrusionDirection?.z ?? 1;
      floorTexts.push({
        x: pt.x * (ez < 0 ? -1 : 1) * unitScale,
        y: pt.y * unitScale,
        floors,
        layer: String(entity.layer ?? "").toUpperCase(),
      });
      continue;
    }
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
    if (inNote(vertices)) {
      noteSkipped++;
      continue;
    }

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

    // M7 지형 — CONTOUR(_<고도>) 레이어: TIN용 3D 점 수집 + 참고선 오버레이 표시 겸용
    if (isContourLayer(upper)) {
      const before = contourStats.meterZ;
      const pts3 = extractContourPoints(entity, upper, unitScale, contourStats);
      if (contourStats.meterZ > before) contourStats.lines++;
      if (!pts3 || pts3.length < 2) {
        warnings.push(`${layer} 레이어에 꼭짓점 2개 미만 선분 무시`);
        continue;
      }
      let closed = entity.shape === true || (entity.flag & 1) === 1;
      const first = pts3[0];
      const last = pts3[pts3.length - 1];
      if (
        pts3.length >= 3 &&
        Math.abs(first.x - last.x) < 1e-9 &&
        Math.abs(first.y - last.y) < 1e-9
      ) {
        pts3.pop();
        closed = true;
      }
      contourPoints.push(...pts3);
      overlays.push({
        layer: "CONTOUR",
        points: pts3.map((p) => ({ x: p.x, y: p.y })),
        closed,
      });
      continue;
    }

    if (CORE_LAYER_RE.test(upper)) {
      const pts = [...vertices];
      if (pts.length >= 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) corePolys.push(pts);
      continue;
    }

    const unitMatch = upper.match(UNIT_LAYER_RE);
    if (unitMatch) {
      // 첫점=끝점 중복 제거 — 닫힘 플래그 없이 그린 것도 받는다
      const pts = [...vertices];
      if (pts.length >= 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) unitPolys.push({ unitType: `${unitMatch[1]}㎡`, points: pts });
      continue;
    }

    // PARCEL_SITE(대상지 내 필지) 등 PARCEL_ 접두 레이어도 필지로 — 나중에 지우기 쉽게 레이어만 나눠 둔 경우
    const overlayLayer =
      OVERLAY_LAYERS.find((l) => l === upper) ?? (upper.startsWith("PARCEL_") ? ("PARCEL" as OverlayLayer) : undefined);
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

  if (noteSkipped > 0) {
    warnings.push(`범례 틀(_ 레이어 닫힌 사각형) 안의 견본 객체 ${noteSkipped}개는 읽지 않았습니다`);
  }
  if (
    polylines.length === 0 &&
    unitPolys.length === 0 &&
    overlays.length === 0 &&
    contourPoints.length === 0 &&
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

  // 유니트·코어가 따로 그려진 동평면을 한 동으로 묶는다.
  // "같은 레이어에 떨어진 폴리곤 여러 개"(= 같은 타입 여러 동 배치)는 건드리지 않는다.
  const mergedPolylines = mergeAdjacentBuildingPolylines(
    polylines,
    warnings,
    unitPolys.map((u) => polygonCentroid(u.points)),
  );
  mergedPolylines.push(...assembleUnitCoreBuildings(polylines, unitPolys, corePolys, warnings));

  const buildings: Building[] = [];
  let planCount = 0;
  let adjCount = 0;
  const planTotal = mergedPolylines.filter(
    (p) => matchBuildingLayer(p.layer)?.isPlan,
  ).length;
  /** 같은 레이어(같은 타입태그)에 폴리라인이 여러 개면 이름 뒤에 -2, -3… 을 붙여 구분 */
  const nameCount = new Map<string, number>();
  /** 타입 레이어(PLAN_A_1 등)별 형상 목록 — 서로 다른 타입이 한 레이어에 섞였는지 검사용 */
  const shapesByTypeLayer = new Map<string, { name: string; sig: string; area: number }[]>();
  /** buildings[i]가 나온 원래 레이어 — 층수 문자 매칭 때 같은 레이어 문자를 허용하려고 */
  const sourceLayers: string[] = [];
  for (const pl of mergedPolylines) {
    const m = matchBuildingLayer(pl.layer)!;
    const isPlan = m.isPlan;
    const type: BuildingType = isPlan ? "계획주동" : "인접건물";
    const floors = m.floors ?? (isPlan ? DEFAULT_FLOORS_PLAN : DEFAULT_FLOORS_ADJ);
    const unitsPerFloor = isPlan ? 4 : 0;
    let name: string;
    if (pl.planType) {
      // 세대 유니트+코어로 만든 동 — 평형 구성을 타입으로: 계획주동_59x2+84x2_1
      const base = `${type}_${pl.planType}`;
      const n = (nameCount.get(base) ?? 0) + 1;
      nameCount.set(base, n);
      name = `${base}_${n}`;
    } else if (m.typeTag !== null) {
      // 권장 규약: PLAN_A_1 → "계획주동_A_1" (라이브러리·목록에서 타입·번호로 바로 식별)
      const base = `${type}_${m.typeTag}_${m.typeNum}`;
      const n = (nameCount.get(base) ?? 0) + 1;
      nameCount.set(base, n);
      name = n > 1 ? `${base}-${n}` : base;
    } else {
      name = isPlan
        ? `계획주동${++planCount > 1 || planTotal > 1 ? " " + planCount : ""}`
        : `인접건물 ${letterSeq(++adjCount)}`; // A, B, … Z, AA, AB …
    }
    // 타입 문자(A/B/…)는 "같은 타입 주동"을 뜻하므로 한 레이어의 형상은 모두 합동이어야 한다.
    // 구버전 PLAN_BLDG/ADJ_BLDG는 타입 구분이 없는 범용 레이어라 검사 대상이 아니다.
    // 인접건물(ADJ_<타입>_<번호>)은 기존 건물이라 모양이 제각각인 게 정상 — 계획주동만 검사한다.
    if (m.typeTag !== null && isPlan) {
      const list = shapesByTypeLayer.get(pl.layer) ?? [];
      list.push({
        name,
        sig: shapeSignature(pl.vertices),
        area: Math.abs(signedArea(pl.vertices)),
      });
      shapesByTypeLayer.set(pl.layer, list);
    }
    sourceLayers.push(pl.layer);
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
      ...(pl.planType ? { planType: pl.planType } : {}),
    });
  }

  // 한 타입 레이어에 형상이 여러 종이면 안내 — 판정은 동별 실제 기하로 하므로 계산에는
  // 영향이 없지만, 목록에서 이름(…-5, …-6)만으로는 어느 동이 다른 형상인지 알 수 없어
  // "같은 타입을 복사·미러한 것"으로 오인하기 쉽다.
  const shapeOddNames = new Set<string>();
  /** 유니트(UNIT_)가 들어 세대 구성이 도면으로 정해진 계획주동 */
  const unitHosts = new Set<Building>();
  for (const [layer, list] of shapesByTypeLayer) {
    const groups = new Map<string, { names: string[]; area: number }>();
    for (const s of list) {
      const g = groups.get(s.sig) ?? { names: [], area: s.area };
      g.names.push(s.name);
      groups.set(s.sig, g);
    }
    if (groups.size <= 1) continue;
    {
      const sorted = [...groups.values()].sort((x, y) => y.names.length - x.names.length);
      for (const g of sorted.slice(1)) for (const n of g.names) shapeOddNames.add(n);
    }
    const desc = [...groups.values()]
      .sort((a, b) => b.names.length - a.names.length)
      .map((g) => {
        // 다수 그룹은 동수만, 소수(어긋난 쪽) 그룹은 이름까지 — 어느 동을 볼지 바로 알 수 있게
        const who = g.names.length <= 2 ? ` — ${g.names.join(", ")}` : "";
        return `${g.area.toFixed(1)}㎡ ${g.names.length}동${who}`;
      })
      .join(" / ");
    warnings.push(
      `${layer} 레이어에 서로 다른 형상 ${groups.size}종이 섞여 있습니다 (${desc}). ` +
        `타입 문자가 같으면 같은 타입 주동을 뜻합니다 — 다른 타입이면 PLAN_B_1 처럼 레이어를 ` +
        `나눠 그리면 목록에서 구분됩니다. 사선·인동·세대수 판정은 동별 실제 형상으로 하므로 영향 없습니다.`,
    );
  }

  // PLAN_WIN/ADJ_WIN 선분을 footprint 에지 **위에 놓였는지**(허용오차 0.1m)로 매칭.
  // 벽 전체를 덮지 않는 부분 창선도 그 벽의 창으로 인정한다(windows.ts segmentLiesOnEdge).
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
          if (segmentLiesOnEdge(p1, p2, wa, wb, WINDOW_MATCH_TOLERANCE)) {
            b.windowSegments.push([wa, wb]);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        unmatchedWin++;
        issues.push({
          kind: "창선 벽 밖",
          message: `${isPlan ? LAYER_PLAN_WIN : LAYER_ADJ_WIN} 창선이 건물 벽 위에 있지 않음`,
          point: { x: (wa.x + wb.x) / 2, y: (wa.y + wb.y) / 2 },
        });
      }
    }
  };
  matchWinLayer(planWinSegments, true);
  matchWinLayer(adjWinSegments, false);
  if (unmatchedWin > 0) {
    warnings.push(
      `${LAYER_PLAN_WIN}/${LAYER_ADJ_WIN} 선분 ${unmatchedWin}개가 어떤 건물 외곽선 위에도 ` +
        `놓여있지 않아 무시됨 (허용오차 ${WINDOW_MATCH_TOLERANCE}m — 창선을 벽면에 스냅해 그려주세요)`,
    );
  }

  if (contourStats.lines > 0) {
    warnings.push(
      `등고선 ${contourStats.lines}개는 고도값이 m 단위로 적힌 것으로 보고 그대로 m로 썼습니다 ` +
        `(도면은 mm 단위 — 예: 50 → 50m). 의도와 다르면 고도값을 mm(50000)로 맞춰 주세요.`,
    );
  }
  const floorsFromText = applyFloorTexts(buildings, sourceLayers, floorTexts, warnings, issues);
  const unitsFromDrawing = applyUnitPolygons(buildings, unitPolys, warnings, issues, unitHosts);
  // 계획주동이 모두 한 타입 레이어(예: PLAN_G_5 하나)에 그려졌으면 레이어로는 타입 구분이 안 된다 —
  // 유니트로 세대 구성이 정해진 동은 평형 구성(예: 59x2+84x1)을 타입으로 쓴다.
  let typedByUnits = false;
  {
    const plans = buildings.filter((b) => b.type === "계획주동" && !b.planType);
    const tags = new Set(plans.map((b) => planTypeOf(b.name)));
    if (tags.size <= 1) {
      for (const b of plans) {
        if (!unitHosts.has(b)) continue;
        b.planType = [...b.unitMix]
          .sort((x, y) => parseFloat(x.unitType) - parseFloat(y.unitType))
          .map((u) => `${u.unitType.replace("㎡", "")}x${u.countPerFloor}`)
          .join("+");
        typedByUnits = true;
      }
    }
  }
  // 형상이 다른 계획주동(소수 쪽) — 이름으로 건물을 찾아 이동할 수 있게.
  // 평형 구성으로 타입을 나눈 경우(한 레이어에 모든 동)는 형상이 다른 게 정상이라 항목으로 띄우지 않는다
  if (typedByUnits) {
    warnings.push("계획주동이 한 레이어에 모두 있어, 유니트(UNIT_) 평형 구성을 동 타입으로 썼습니다 (층수 일괄 입력에서 같은 구성끼리 묶임)");
  }
  for (const b of typedByUnits ? [] : buildings) {
    if (shapeOddNames.has(b.name)) {
      issues.push({ kind: "형상 다름", message: `${b.name} — 같은 타입 레이어의 다른 동과 형상이 다름`, building: b });
    }
  }
  const usesFromText = applyUseTexts(buildings, useTexts, warnings);
  applyNameTexts(buildings, nameTexts, warnings, issues);

  return {
    buildings, overlays, contourPoints, warnings, unitScale, unitSource, floorsFromText, unitsFromDrawing, issues,
    usesFromText,
  };
}

/**
 * PLAN_ 외곽선 밖에 그려진 세대 유니트(UNIT_<평형>)·코어(PLAN_CORE)를 벽 공유로 묶어 계획주동
 * 외곽선을 만든다. 유니트가 하나도 없는 덩어리(코어만)는 주동으로 보지 않는다.
 * 만든 외곽선은 구버전 범용 레이어(PLAN_BLDG)로 넘겨 "계획주동 n"으로 이름 붙는다.
 */
function assembleUnitCoreBuildings(
  planLines: RawPolyline[],
  units: { unitType: string; points: Point2[] }[],
  cores: Point2[][],
  warnings: string[],
): RawPolyline[] {
  const outlines = planLines.filter((p) => matchBuildingLayer(p.layer)?.isPlan).map((p) => p.vertices);
  const free = (pts: Point2[]) => {
    const c = polygonCentroid(pts);
    return !outlines.some((o) => pointInPolygon(c.x, c.y, o));
  };
  const pieces: { pts: Point2[]; unit: boolean; type?: string }[] = [
    ...units.filter((u) => free(u.points)).map((u) => ({ pts: u.points, unit: true, type: u.unitType.replace("㎡", "") })),
    ...cores.filter(free).map((pts) => ({ pts, unit: false })),
  ];
  if (!pieces.some((p) => p.unit)) {
    if (cores.length && !outlines.length) warnings.push(`${LAYER_CORE} 코어만 있고 세대 유니트(UNIT_<평형>)가 없어 주동을 만들지 않았습니다`);
    return [];
  }
  const result = unionAdjacentPolygons(pieces.map((p) => p.pts));
  for (const f of result.failures) warnings.push(`세대 유니트·코어 합치기 — ${f}`);
  const out: RawPolyline[] = [];
  let coreOnly = 0;
  result.polygons.forEach((poly, i) => {
    const us = result.sources[i].filter((k) => pieces[k].unit);
    if (!us.length) {
      coreOnly++;
      return;
    }
    // 평형 구성 → 타입 문자열 (작은 평형부터): 59x2+84x2
    const cnt = new Map<string, number>();
    for (const k of us) cnt.set(pieces[k].type!, (cnt.get(pieces[k].type!) ?? 0) + 1);
    const planType = [...cnt]
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([t, c]) => `${t}x${c}`)
      .join("+");
    out.push({ layer: LAYER_PLAN_PREFIX, vertices: poly, closed: true, planType });
  });
  warnings.push(
    `세대 유니트(UNIT_)·코어(${LAYER_CORE}) ${pieces.length}개를 벽 공유로 묶어 계획주동 ${out.length}동을 만들었습니다` +
      (coreOnly ? ` — 유니트와 맞닿지 않은 코어 ${coreOnly}개는 제외` : ""),
  );
  return out;
}

/** 건물 외곽선 안의 BLDG_NAME 문자로 동 이름을 정한다 (타입은 planType으로 유지) */
function applyNameTexts(
  buildings: Building[],
  texts: { x: number; y: number; name: string }[],
  warnings: string[],
  issues: DxfIssue[] = [],
): void {
  if (!texts.length) return;
  let orphan = 0;
  const used = new Set<string>();
  for (const t of texts) {
    const b = buildings.find((x) => pointInPolygon(t.x, t.y, x.footprint));
    if (!b) {
      orphan++;
      issues.push({ kind: "동 이름 밖", message: `동 이름 "${t.name}"이 건물 외곽선 밖에 있음`, point: { x: t.x, y: t.y } });
      continue;
    }
    if (b.type === "계획주동" && !b.planType) {
      // 이름이 바뀌어도 층수 일괄 입력의 타입 묶음은 원래 이름(계획주동_A_1 → A)에서 유지
      const m = b.name.match(/_([A-Za-z0-9]+)_\d+(?:-\d+)?$/);
      if (m) b.planType = m[1].toUpperCase();
    }
    let name = t.name;
    for (let k = 2; used.has(name); k++) name = `${t.name}-${k}`;
    used.add(name);
    b.name = name;
  }
  if (orphan) {
    warnings.push(`${LAYER_NAME_TEXT} 동 이름 문자 ${orphan}개가 어떤 건물 외곽선 안에도 있지 않아 무시했습니다`);
  }
}

/** 밑줄(_)로 시작하는 레이어의 닫힌 폴리라인 = 범례 틀 → 도면 좌표(m) 경계 상자 */
function collectNoteFrames(entities: any[], unitScale: number): { x0: number; y0: number; x1: number; y1: number }[] {
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const e of entities) {
    if (!String(e.layer ?? "").startsWith("_")) continue;
    if (e.type !== "LWPOLYLINE" && e.type !== "POLYLINE") continue;
    const vs: any[] = e.vertices ?? [];
    if (vs.length < 3) continue;
    const a = vs[0], b = vs[vs.length - 1];
    const closed = e.shape === true || (e.flag & 1) === 1 || (vs.length >= 4 && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
    if (!closed) continue;
    const ez: number = e.extrusionDirectionZ ?? e.extrusionDirection?.z ?? 1;
    const xs = vs.map((v) => v.x * (ez < 0 ? -1 : 1) * unitScale);
    const ys = vs.map((v) => v.y * unitScale);
    out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return out;
}

/** TEXT는 정렬 지정(72/73)이 있으면 두 번째 정렬점(11)이 실제 기준 위치다 */
function textAnchor(entity: any): { x: number; y: number } | null {
  const aligned = entity.type === "TEXT" && ((entity.halign ?? 0) !== 0 || (entity.valign ?? 0) !== 0);
  const pt = entity.type === "MTEXT"
    ? entity.position
    : aligned && entity.endPoint ? entity.endPoint : entity.startPoint;
  return pt ?? null;
}

/** 건물 외곽선 안의 BLDG_USE 문자로 시설 용도를 정한다 */
function applyUseTexts(
  buildings: Building[],
  texts: { x: number; y: number; use: FacilityUse }[],
  warnings: string[],
): number {
  if (texts.length === 0) return 0;
  let applied = 0;
  const used = new Set<number>();
  for (const b of buildings) {
    texts.forEach((t, k) => {
      if (used.has(k) || !pointInPolygon(t.x, t.y, b.footprint)) return;
      b.use = t.use;
      used.add(k);
    });
    if (b.use) applied++;
  }
  const orphan = texts.length - used.size;
  if (orphan > 0) {
    warnings.push(
      `${LAYER_USE_TEXT} 용도 문자 ${orphan}개가 어떤 건물 외곽선 안에도 있지 않아 무시했습니다 — ` +
        `문자 기준점이 건물 안쪽에 오도록 옮겨 주세요.`,
    );
  }
  return applied;
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

/** 지정한 offset만큼 건물(footprint+windowSegments)·오버레이·등고선 좌표를 평행이동 (원점 보정 적용) */
export function applyRecenterOffset(
  offset: Point2,
  buildings: Building[],
  overlays: OverlayLine[],
  contourPoints?: Point3[],
): void {
  const shift = (p: Point2): Point2 => ({ x: p.x - offset.x, y: p.y - offset.y });
  for (const b of buildings) {
    b.footprint = b.footprint.map(shift);
    b.windowSegments = b.windowSegments.map(([a, c]) => [shift(a), shift(c)]);
  }
  for (const o of overlays) {
    o.points = o.points.map(shift);
  }
  if (contourPoints) {
    for (const p of contourPoints) {
      p.x -= offset.x;
      p.y -= offset.y;
    }
  }
}

/**
 * 건물 외곽선 안에 든 층수 문자를 그 건물의 층수로 쓴다.
 * - 대상 문자: BLDG_FLOORS 레이어, 또는 그 건물과 같은 레이어에 적힌 숫자 문자
 * - 레이어 접미사(_15F)보다 우선한다 — 동마다 적은 값이 더 구체적이기 때문
 * - 한 건물 안에 서로 다른 층수가 둘 이상이면 가장 큰 값을 쓰고 알린다
 * @returns 층수 문자로 층수가 정해진 동 수
 */
function applyFloorTexts(
  buildings: Building[],
  sourceLayers: string[],
  texts: { x: number; y: number; floors: number; layer: string }[],
  warnings: string[],
  issues: DxfIssue[] = [],
): number {
  // 층수 정보가 전혀 없는 주변 건물 (레이어 접미사도 문자도 없음) — 1층으로 들어간다
  const noFloors = (b: Building, i: number) =>
    b.type === "인접건물" && matchBuildingLayer(sourceLayers[i])?.floors == null;
  if (texts.length === 0) {
    buildings.forEach((b, i) => {
      if (noFloors(b, i)) issues.push({ kind: "층수 없음", message: `${b.name} — 층수 정보 없음(1층으로 들어옴)`, building: b });
    });
    return 0;
  }
  let applied = 0;
  const conflicts: string[] = [];
  const used = new Set<number>();
  buildings.forEach((b, i) => {
    const xs = b.footprint.map((p) => p.x);
    const ys = b.footprint.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const hits: number[] = [];
    texts.forEach((t, k) => {
      if (t.layer !== LAYER_FLOOR_TEXT && t.layer !== sourceLayers[i]) return;
      if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) return;
      if (!pointInPolygon(t.x, t.y, b.footprint)) return;
      hits.push(t.floors);
      used.add(k);
    });
    if (hits.length === 0) {
      if (noFloors(b, i)) issues.push({ kind: "층수 없음", message: `${b.name} — 층수 정보 없음(1층으로 들어옴)`, building: b });
      return;
    }
    const distinct = [...new Set(hits)];
    b.floors = Math.max(...distinct);
    applied++;
    if (distinct.length > 1) {
      conflicts.push(`${b.name}(${distinct.join("/")}층 → ${b.floors}층)`);
      issues.push({ kind: "층수 충돌", message: `${b.name} — 층수 문자 ${distinct.join("/")}층, ${b.floors}층으로 씀`, building: b });
    }
  });
  if (conflicts.length > 0) {
    warnings.push(
      `한 건물 안에 층수 문자가 서로 다르게 ${conflicts.length}동 적혀 있어 가장 큰 값을 썼습니다: ` +
        conflicts.slice(0, 8).join(", ") + (conflicts.length > 8 ? " …" : ""),
    );
  }
  texts.forEach((t, k) => {
    if (t.layer === LAYER_FLOOR_TEXT && !used.has(k)) {
      issues.push({ kind: "층수 문자 밖", message: `층수 문자 "${t.floors}"가 건물 외곽선 밖에 있음`, point: { x: t.x, y: t.y } });
    }
  });
  const orphan = texts.filter((t, k) => t.layer === LAYER_FLOOR_TEXT && !used.has(k)).length;
  if (orphan > 0) {
    warnings.push(
      `${LAYER_FLOOR_TEXT} 층수 문자 ${orphan}개가 어떤 건물 외곽선 안에도 있지 않아 무시했습니다 — ` +
        `문자 기준점이 건물 안쪽에 오도록 옮겨 주세요.`,
    );
  }
  return applied;
}

/** 폴리곤 면적 무게중심 — 오목해도 대개 안쪽이지만 아니면 꼭짓점 판정으로 보완한다 */
function polygonCentroid(pts: Point2[]): Point2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-12) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * 평형별 전용공간(UNIT_<평형>)을 주동마다 세어 세대 구성(평형별 층당 세대수)으로 넣는다.
 * 전용공간 하나 = 그 층의 세대 하나. 전용공간이 하나라도 든 계획주동만 바꾸고, 없는 동은
 * 기본 구성을 그대로 둔다. 어느 주동에도 안 든 전용공간은 알린다.
 * @returns 세대 구성이 도면으로 정해진 동 수
 */
function applyUnitPolygons(
  buildings: Building[],
  units: { unitType: string; points: Point2[] }[],
  warnings: string[],
  issues: DxfIssue[] = [],
  hosts?: Set<Building>,
): number {
  if (units.length === 0) return 0;
  const plans = buildings.filter((b) => b.type === "계획주동");
  const counts = new Map<Building, Map<string, number>>();
  let orphan = 0;
  for (const u of units) {
    const c = polygonCentroid(u.points);
    const inside = (b: Building) =>
      pointInPolygon(c.x, c.y, b.footprint) ||
      u.points.filter((p) => pointInPolygon(p.x, p.y, b.footprint)).length > u.points.length / 2;
    const host = plans.find(inside);
    if (!host) {
      orphan++;
      issues.push({ kind: "유니트 주동 밖", message: `UNIT_${u.unitType.replace("㎡", "")} 유니트가 어느 주동에도 속하지 않음`, point: c });
      continue;
    }
    const m = counts.get(host) ?? new Map<string, number>();
    m.set(u.unitType, (m.get(u.unitType) ?? 0) + 1);
    counts.set(host, m);
  }
  for (const [b, m] of counts) {
    hosts?.add(b);
    b.unitMix = [...m.entries()]
      .sort((x, y) => parseFloat(x[0]) - parseFloat(y[0]))
      .map(([unitType, countPerFloor]) => ({ unitType, countPerFloor }));
    b.unitsPerFloor = b.unitMix.reduce((s, e) => s + e.countPerFloor, 0);
  }
  if (orphan > 0) {
    warnings.push(
      `UNIT_ 전용공간 ${orphan}개가 어느 계획주동 외곽선 안에도 있지 않아 세대수에서 빠졌습니다 — ` +
        `전용공간이 주동 외곽선(PLAN_) 안쪽에 오게 그려 주세요.`,
    );
  }
  return counts.size;
}
