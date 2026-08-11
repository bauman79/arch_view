import { worldFootprint, worldTransformer } from "./buildings";
import { buildingHeight, type Building, type OverlayLine, type Point2, type Project } from "./types";

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

// ============================================================
// 시점별 내보내기 — 평면 외에 입면·아이소 투영
// ============================================================

/**
 * 내보내기 시점. "top"은 위의 buildDxfText(평면 footprint)를 그대로 쓴다 —
 * 라운드트립(내보낸 DXF를 다시 불러오면 같은 배치로 복원)이 걸린 유일한 모드라
 * 절대 투영 경로를 타면 안 된다.
 */
export type DxfViewMode = "top" | "iso" | "south" | "east" | "west";

export const DXF_VIEW_LABEL: Record<DxfViewMode, string> = {
  top: "평면",
  iso: "아이소",
  south: "남측 입면",
  east: "동측 입면",
  west: "서측 입면",
};

/** 아이소메트릭 투영 계수 — 표준 30° */
const ISO_COS30 = Math.cos(Math.PI / 6);
const ISO_SIN30 = 0.5;

/**
 * 3D 점(도면 평면 x=동, y=북, z=높이)을 시점 평면 2D로 투영한다. 단위는 입력 그대로(m).
 *
 * 축척은 어느 시점에서도 1:1이다 — 입면은 정투영이라 화면 가로가 실제 수평거리,
 * 세로가 실제 높이이고, 아이소는 30° 정각투영이라 세 축 모두 같은 비율로 줄어든다
 * (등각투영의 정의). 따라서 CAD에서 잰 치수가 실제 치수와 같다.
 */
function projectPoint(
  x: number,
  y: number,
  z: number,
  view: Exclude<DxfViewMode, "top">,
): Point2 {
  switch (view) {
    // 남쪽에서 북쪽을 본다 — 동(x)이 오른쪽, 높이가 위
    case "south":
      return { x, y: z };
    // 동쪽에서 서쪽을 본다 — 북(y)이 오른쪽
    case "east":
      return { x: y, y: z };
    // 서쪽에서 동쪽을 본다 — 북이 왼쪽이므로 부호 반전
    case "west":
      return { x: -y, y: z };
    case "iso":
      return { x: (x - y) * ISO_COS30, y: (x + y) * ISO_SIN30 + z };
  }
}

/** 건물의 바닥/상단 표고(m) — M7 지형 G.L.이 있으면 그 위에 얹힌다 */
function buildingLevels(b: Building): { base: number; top: number } {
  const base = b.terrainElevation ?? 0;
  return { base, top: base + buildingHeight(b) };
}

/**
 * 건물 한 동을 시점 평면의 선분 목록으로. 좌표는 m(원점 복원 전).
 *
 * - 입면(south/east/west): 정투영이라 footprint의 깊이 방향이 한 점으로 눌린다.
 *   윤곽만 그리면 폭·높이는 맞지만 층 구성을 읽을 수 없어, 투영 폭 사각형 +
 *   층선(각 층 바닥 레벨)을 함께 낸다 — 건축 입면도의 통상적인 표현.
 * - 아이소: 프리즘 와이어프레임(하단·상단 다각형 + 수직 모서리). 숨은선 제거는
 *   하지 않는다(CAD에서 정리하는 편이 낫고, 제거하면 치수를 잃는다).
 */
function buildingSegments(
  b: Building,
  world: Point2[],
  view: Exclude<DxfViewMode, "top">,
): [Point2, Point2][] {
  const { base, top } = buildingLevels(b);
  const segs: [Point2, Point2][] = [];

  if (view === "iso") {
    const n = world.length;
    for (let i = 0; i < n; i++) {
      const p = world[i];
      const q = world[(i + 1) % n];
      // 하단 · 상단 다각형
      segs.push([
        projectPoint(p.x, p.y, base, view),
        projectPoint(q.x, q.y, base, view),
      ]);
      segs.push([
        projectPoint(p.x, p.y, top, view),
        projectPoint(q.x, q.y, top, view),
      ]);
      // 수직 모서리
      segs.push([
        projectPoint(p.x, p.y, base, view),
        projectPoint(p.x, p.y, top, view),
      ]);
    }
    return segs;
  }

  // 입면 — 투영 가로 좌표의 범위가 곧 그 시점에서 보이는 폭
  const us = world.map((p) => projectPoint(p.x, p.y, base, view).x);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const rect: Point2[] = [
    { x: uMin, y: base },
    { x: uMax, y: base },
    { x: uMax, y: top },
    { x: uMin, y: top },
  ];
  for (let i = 0; i < 4; i++) segs.push([rect[i], rect[(i + 1) % 4]]);

  // 층선 — 1층 바닥(base)과 최상단은 외곽선과 겹치므로 사이 레벨만
  for (let f = 1; f < b.floors; f++) {
    const z = base + f * b.floorHeight;
    segs.push([
      { x: uMin, y: z },
      { x: uMax, y: z },
    ]);
  }
  return segs;
}

/**
 * 선택한 시점의 DXF 텍스트. "top"이면 기존 평면 내보내기를 그대로 위임한다.
 *
 * 투영 시점에서는 대지경계 등 2D 오버레이도 z=0 평면에 놓인 것으로 보고 함께 투영한다
 * (입면에서는 지반선으로, 아이소에서는 바닥 윤곽으로 보인다).
 * 레이어·색 규약은 평면과 동일해 CAD에서 같은 방식으로 정리할 수 있다.
 */
export function buildDxfTextForView(
  project: Project,
  origin: Point2 | null,
  view: DxfViewMode,
): string {
  if (view === "top") return buildDxfText(project, origin);

  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  /** 투영 평면 m → 도면 mm. 투영 좌표에는 원점 보정이 의미가 없으므로 축척만 건다 */
  const toMm = (p: Point2): Point2 => ({ x: p.x * 1000, y: p.y * 1000 });

  const w = mkWriter();

  w.pair(0, "SECTION");
  w.pair(2, "HEADER");
  w.pair(9, "$ACADVER");
  w.pair(1, "AC1009");
  w.pair(9, "$INSUNITS");
  w.pair(70, 4); // mm
  w.pair(0, "ENDSEC");

  // 레이어 구성은 평면과 동일 규약
  const layers = new Map<string, number>();
  const buildingLayers = new Map<string, string>();
  let planSeq = 0;
  for (const b of project.buildings) {
    const isPlan = b.type === "계획주동";
    const name = exportLayerName(b, isPlan ? ++planSeq : 0);
    buildingLayers.set(b.id, name);
    layers.set(name, ENTITY_COLOR[isPlan ? "PLAN" : "ADJ"]);
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

  w.pair(0, "SECTION");
  w.pair(2, "ENTITIES");

  for (const b of project.buildings) {
    const layer = buildingLayers.get(b.id)!;
    const color = ENTITY_COLOR[b.type === "계획주동" ? "PLAN" : "ADJ"];
    // 원본 도면 좌표계로 되돌린 뒤 투영해야 시점 간 위치 관계가 유지된다
    const world = worldFootprint(b).map((p) => ({ x: p.x + ox, y: p.y + oy }));
    for (const [a, c] of buildingSegments(b, world, view)) {
      writeLine(w, layer, color, toMm(a), toMm(c));
    }
  }

  for (const o of project.siteOverlays) {
    const color = ENTITY_COLOR[o.layer] ?? 7;
    const pts = o.points.map((p) =>
      projectPoint(p.x + ox, p.y + oy, 0, view),
    );
    const n = pts.length;
    const last = o.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      writeLine(w, o.layer, color, toMm(pts[i]), toMm(pts[(i + 1) % n]));
    }
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
