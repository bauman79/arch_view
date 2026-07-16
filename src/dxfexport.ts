import { worldFootprint, worldTransformer } from "./buildings";
import type { Building, OverlayLine, Point2, Project } from "./types";

/**
 * 현재 배치(장면의 건물 + 창면 + 오버레이)를 DXF로 내보낸다.
 *
 * - 형식: R12 ASCII (POLYLINE/VERTEX/SEQEND + LINE) — 구버전·타 CAD까지 두루 열리는
 *   가장 보수적인 형식. LWPOLYLINE(R14+)은 핸들·서브클래스 마커 요구가 있어 쓰지 않는다.
 * - 레이어·색상: data/DXF_RULES.md 규약 그대로 — 다시 "DXF 불러오기"로 열면
 *   같은 건물·창면·오버레이로 복원된다(라운드트립).
 * - 좌표: 화면 좌표(m, 원점 보정됨)에 sceneOrigin을 되돌려 더한 뒤 mm로 환산 —
 *   원본 도면과 같은 위치에 겹쳐진다.
 */

/** 엔티티 색(62) — 첨부 규약 도면(sample_site_test5.dxf)과 동일한 매핑 */
const ENTITY_COLOR: Record<string, number> = {
  PLAN: 7, // 계획주동 — 흰색
  ADJ: 6, // 인접건물 — 자홍
  PLAN_WIN: 6,
  ADJ_WIN: 6,
  SITE_BOUNDARY: 1,
  ADJ_BOUNDARY: 2,
  ROAD_CL: 4,
  PARK_BOUNDARY: 3,
  CONTOUR: 7,
};

const FMT = (v: number): string => {
  // mm 단위 좌표 — 소수 3자리면 0.001mm 정밀도로 충분
  const s = v.toFixed(3);
  return s === "-0.000" ? "0.000" : s;
};

interface DxfWriter {
  lines: string[];
  pair(code: number, value: string | number): void;
}

function mkWriter(): DxfWriter {
  const lines: string[] = [];
  return {
    lines,
    pair(code, value) {
      lines.push(String(code), String(value));
    },
  };
}

/** 닫힌/열린 POLYLINE (R12: POLYLINE + VERTEX… + SEQEND) */
function writePolyline(
  w: DxfWriter,
  layer: string,
  color: number,
  pts: Point2[],
  closed: boolean,
): void {
  w.pair(0, "POLYLINE");
  w.pair(8, layer);
  w.pair(62, color);
  w.pair(66, 1); // vertices follow
  w.pair(70, closed ? 1 : 0);
  for (const p of pts) {
    w.pair(0, "VERTEX");
    w.pair(8, layer);
    w.pair(10, FMT(p.x));
    w.pair(20, FMT(p.y));
    w.pair(30, "0.0");
  }
  w.pair(0, "SEQEND");
  w.pair(8, layer);
}

function writeLine(
  w: DxfWriter,
  layer: string,
  color: number,
  a: Point2,
  b: Point2,
): void {
  w.pair(0, "LINE");
  w.pair(8, layer);
  w.pair(62, color);
  w.pair(10, FMT(a.x));
  w.pair(20, FMT(a.y));
  w.pair(30, "0.0");
  w.pair(11, FMT(b.x));
  w.pair(21, FMT(b.y));
  w.pair(31, "0.0");
}

/** 건물의 내보내기 레이어명 — 규약(PLAN_<타입>_<번호>_<층수>F / ADJ_BLDG_<층수>F) */
export function exportLayerName(b: Building, planSeq: number): string {
  if (b.type === "계획주동") return `PLAN_A_${planSeq}_${b.floors}F`;
  return `ADJ_BLDG_${b.floors}F`;
}

/**
 * DXF 텍스트 생성.
 * @param origin DXF 로드 시 화면 중앙 보정에 쓴 sceneOrigin(m) — 되돌려 더해
 *   원본 도면 좌표계로 복원한다. 템플릿만으로 만든 장면이면 null(그대로 내보냄).
 */
export function buildDxfText(project: Project, origin: Point2 | null): string {
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  /** m(화면) → mm(도면, 원점 복원) */
  const toMm = (p: Point2): Point2 => ({ x: (p.x + ox) * 1000, y: (p.y + oy) * 1000 });

  const w = mkWriter();

  // ---------- HEADER ----------
  w.pair(0, "SECTION");
  w.pair(2, "HEADER");
  w.pair(9, "$ACADVER");
  w.pair(1, "AC1009"); // R12 — 가장 보수적
  w.pair(9, "$INSUNITS");
  w.pair(70, 4); // mm — 다시 불러올 때 자동감지
  w.pair(0, "ENDSEC");

  // ---------- TABLES (LTYPE + LAYER) ----------
  const layers = new Map<string, number>(); // 레이어명 → 색 (레이어 테이블용)
  let planSeq = 0;
  const buildingLayers = new Map<string, string>(); // building.id → 레이어명
  for (const b of project.buildings) {
    const isPlan = b.type === "계획주동";
    const name = exportLayerName(b, isPlan ? ++planSeq : 0);
    buildingLayers.set(b.id, name);
    layers.set(name, ENTITY_COLOR[isPlan ? "PLAN" : "ADJ"]);
    if (b.windowSegments.length > 0) {
      const winLayer = isPlan ? "PLAN_WIN" : "ADJ_WIN";
      layers.set(winLayer, ENTITY_COLOR[winLayer]);
    }
  }
  for (const o of project.siteOverlays) {
    layers.set(o.layer, ENTITY_COLOR[o.layer] ?? 7);
  }

  w.pair(0, "SECTION");
  w.pair(2, "TABLES");
  w.pair(0, "TABLE");
  w.pair(2, "LTYPE");
  w.pair(70, 1);
  w.pair(0, "LTYPE");
  w.pair(2, "CONTINUOUS");
  w.pair(70, 0);
  w.pair(3, "Solid line");
  w.pair(72, 65);
  w.pair(73, 0);
  w.pair(40, "0.0");
  w.pair(0, "ENDTAB");
  w.pair(0, "TABLE");
  w.pair(2, "LAYER");
  w.pair(70, layers.size);
  for (const [name, color] of layers) {
    w.pair(0, "LAYER");
    w.pair(2, name);
    w.pair(70, 0);
    w.pair(62, color);
    w.pair(6, "CONTINUOUS");
  }
  w.pair(0, "ENDTAB");
  w.pair(0, "ENDSEC");

  // ---------- ENTITIES ----------
  w.pair(0, "SECTION");
  w.pair(2, "ENTITIES");

  for (const b of project.buildings) {
    const layer = buildingLayers.get(b.id)!;
    const isPlan = b.type === "계획주동";
    writePolyline(
      w,
      layer,
      ENTITY_COLOR[isPlan ? "PLAN" : "ADJ"],
      worldFootprint(b).map(toMm),
      true,
    );
    // 창면 — footprint와 같은 이동·회전을 적용해 벽 위 좌표로 내보낸다
    const tf = worldTransformer(b);
    const winLayer = isPlan ? "PLAN_WIN" : "ADJ_WIN";
    for (const [a, c] of b.windowSegments) {
      writeLine(w, winLayer, ENTITY_COLOR[winLayer], toMm(tf(a)), toMm(tf(c)));
    }
  }

  for (const o of project.siteOverlays) {
    writePolyline(
      w,
      o.layer,
      ENTITY_COLOR[o.layer] ?? 7,
      o.points.map(toMm),
      o.closed,
    );
  }

  w.pair(0, "ENDSEC");
  w.pair(0, "EOF");
  return w.lines.join("\r\n") + "\r\n";
}

/** 내보낼 것이 있는지 (버튼 가드용) */
export function hasExportContent(project: Project): boolean {
  return project.buildings.length > 0 || project.siteOverlays.length > 0;
}

/** 오버레이 타입 재수출 — main.ts에서 import 편의용 */
export type { OverlayLine };
