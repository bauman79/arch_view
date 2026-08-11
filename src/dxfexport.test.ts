import { describe, expect, it } from "vitest";
import { parseDxfBuildings } from "./dxf";
import { buildDxfText, buildDxfTextForView } from "./dxfexport";
import { createTemplateBuilding } from "./massing";
import { defaultProject, type Point2, type Project } from "./types";
import { edgeHasWindow } from "./windows";

/**
 * 배치도 DXF 내보내기 — 내보낸 텍스트를 파서(parseDxfBuildings)로 다시 읽어
 * 건물·층수·창면·오버레이·좌표가 복원되는지 라운드트립으로 검증한다.
 */

function mkProject(): Project {
  const p = defaultProject();

  const plan = createTemplateBuilding("slab", 4, 1, 1); // 44×12 장방형
  plan.floors = 12;
  plan.offset = { dx: 5, dy: -3, rotation: 0 };
  // 남측 장변(모서리 좌표는 templateFootprint 기준 ±22, ±6)에 창면
  plan.windowSegments = [[{ x: -22, y: -6 }, { x: 22, y: -6 }]];
  p.buildings.push(plan);

  const adj = createTemplateBuilding("tower", 6, 1, 2);
  adj.type = "인접건물";
  adj.name = "인접건물 A";
  adj.floors = 5;
  adj.unitsPerFloor = 0;
  adj.unitMix = [];
  adj.offset = { dx: 60, dy: 40, rotation: 0 };
  p.buildings.push(adj);

  p.siteOverlays = [
    {
      layer: "SITE_BOUNDARY",
      closed: true,
      points: [
        { x: -80, y: -80 },
        { x: 80, y: -80 },
        { x: 80, y: 80 },
        { x: -80, y: 80 },
      ],
    },
    {
      layer: "ROAD_CL",
      closed: false,
      points: [
        { x: -80, y: -90 },
        { x: 80, y: -90 },
      ],
    },
  ];
  return p;
}

describe("배치도 DXF 내보내기 라운드트립", () => {
  const origin: Point2 = { x: 1000, y: 2000 }; // sceneOrigin(m) 복원 검증용

  it("내보낸 DXF를 다시 불러오면 건물·층수·오버레이가 복원된다", () => {
    const text = buildDxfText(mkProject(), origin);
    const r = parseDxfBuildings(text, "auto");

    expect(r.unitSource).toBe("header-mm"); // $INSUNITS=4 인식
    const plans = r.buildings.filter((b) => b.type === "계획주동");
    const adjs = r.buildings.filter((b) => b.type === "인접건물");
    expect(plans).toHaveLength(1);
    expect(adjs).toHaveLength(1);
    expect(plans[0].floors).toBe(12); // PLAN_A_1_12F 레이어 접미사
    expect(adjs[0].floors).toBe(5); // ADJ_BLDG_5F
    expect(r.overlays).toHaveLength(2);
    expect(r.overlays.find((o) => o.layer === "SITE_BOUNDARY")?.closed).toBe(true);
    expect(r.overlays.find((o) => o.layer === "ROAD_CL")?.closed).toBe(false);
  });

  it("좌표가 sceneOrigin 복원 + offset 반영으로 나온다 (m→mm)", () => {
    const text = buildDxfText(mkProject(), origin);
    const r = parseDxfBuildings(text, "auto");
    const plan = r.buildings.find((b) => b.type === "계획주동")!;
    // 원본: centroid(0,0) 장방형 ±22/±6 + offset(5,-3) + origin(1000,2000)
    const xs = plan.footprint.map((p) => p.x);
    const ys = plan.footprint.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(1000 + 5 - 22, 3);
    expect(Math.max(...xs)).toBeCloseTo(1000 + 5 + 22, 3);
    expect(Math.min(...ys)).toBeCloseTo(2000 - 3 - 6, 3);
    expect(Math.max(...ys)).toBeCloseTo(2000 - 3 + 6, 3);
  });

  it("창면(PLAN_WIN)이 같은 변환을 거쳐 벽 위에 복원·매칭된다", () => {
    const text = buildDxfText(mkProject(), origin);
    const r = parseDxfBuildings(text, "auto");
    const plan = r.buildings.find((b) => b.type === "계획주동")!;
    expect(plan.windowSegments).toHaveLength(1);
    // 남측 벽(최소 y)의 에지에 창이 매칭됐는지
    const n = plan.footprint.length;
    let matched = false;
    for (let i = 0; i < n; i++) {
      if (edgeHasWindow(plan.footprint[i], plan.footprint[(i + 1) % n], plan.windowSegments)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it("회전된 건물도 회전 반영된 좌표로 내보내진다", () => {
    const p = mkProject();
    p.buildings[0].offset.rotation = 90;
    const text = buildDxfText(p, null);
    const r = parseDxfBuildings(text, "auto");
    const plan = r.buildings.find((b) => b.type === "계획주동")!;
    // 90° 회전: 44×12 → 12×44 (offset 5,-3 중심)
    const xs = plan.footprint.map((p2) => p2.x);
    const ys = plan.footprint.map((p2) => p2.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(44, 3);
    // 창면도 함께 회전 — 여전히 벽에 매칭
    const n = plan.footprint.length;
    let matched = false;
    for (let i = 0; i < n; i++) {
      if (edgeHasWindow(plan.footprint[i], plan.footprint[(i + 1) % n], plan.windowSegments)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it("규약 색상이 엔티티(62)에 실린다 — PLAN 7 · 창 6 · SITE 1", () => {
    const text = buildDxfText(mkProject(), null);
    // POLYLINE 층위의 원시 텍스트 검사 (파서는 색을 버리므로 텍스트로 확인)
    expect(text).toMatch(/POLYLINE\r\n8\r\nPLAN_A_1_12F\r\n62\r\n7\r\n/);
    expect(text).toMatch(/LINE\r\n8\r\nPLAN_WIN\r\n62\r\n6\r\n/);
    expect(text).toMatch(/POLYLINE\r\n8\r\nSITE_BOUNDARY\r\n62\r\n1\r\n/);
  });
});

/**
 * 시점별 내보내기 — 사용자가 고른 표준 시점(아이소/입면)이 실제 치수로
 * 나가는지, 레이어 구분이 평면과 같은 규약으로 유지되는지 검증한다.
 */

/** DXF 텍스트에서 LINE 엔티티를 (레이어, 시작, 끝) 목록으로 뽑는다 (mm 단위) */
function readLines(dxf: string): { layer: string; a: Point2; b: Point2 }[] {
  const t = dxf.split(/\r\n/);
  const out: { layer: string; a: Point2; b: Point2 }[] = [];
  for (let i = 0; i < t.length - 1; i += 2) {
    if (t[i] !== "0" || t[i + 1] !== "LINE") continue;
    const v: Record<string, string> = {};
    for (let j = i + 2; j < t.length - 1; j += 2) {
      if (t[j] === "0") break;
      v[t[j]] = t[j + 1];
    }
    out.push({
      layer: v["8"],
      a: { x: parseFloat(v["10"]), y: parseFloat(v["20"]) },
      b: { x: parseFloat(v["11"]), y: parseFloat(v["21"]) },
    });
  }
  return out;
}

/** 엔티티 전체의 바운딩 박스 (mm) */
function bbox(lines: { a: Point2; b: Point2 }[]) {
  const xs = lines.flatMap((l) => [l.a.x, l.b.x]);
  const ys = lines.flatMap((l) => [l.a.y, l.b.y]);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/** 단일 주동만 있는 프로젝트 — 치수를 손으로 계산해 대조하기 위한 최소 구성 */
function singleBuilding(floors: number, floorHeight: number): Project {
  const p = defaultProject();
  const b = createTemplateBuilding("slab", 4, 1, 1); // 44m × 12m
  b.floors = floors;
  b.floorHeight = floorHeight;
  b.offset = { dx: 0, dy: 0, rotation: 0 };
  b.windowSegments = [];
  p.buildings.push(b);
  return p;
}

describe("시점별 DXF 내보내기 — 실제 치수", () => {
  it('평면("top")은 기존 배치도 경로를 그대로 쓴다 (라운드트립 보존)', () => {
    const p = mkProject();
    expect(buildDxfTextForView(p, null, "top")).toBe(buildDxfText(p, null));
  });

  it("남측 입면: 폭 = 실제 동서 길이, 높이 = 층수 × 층고 (1:1)", () => {
    const p = singleBuilding(12, 2.8); // 44m × (12×2.8=33.6m)
    const lines = readLines(buildDxfTextForView(p, null, "south"));
    const bb = bbox(lines);
    expect(bb.w).toBeCloseTo(44_000, 1); // 44m → mm
    expect(bb.h).toBeCloseTo(33_600, 1); // 33.6m → mm
    expect(bb.minY).toBeCloseTo(0, 1); // 지반선에서 시작
  });

  it("동측 입면: 폭 = 실제 남북 깊이 (같은 동을 옆에서 본 값)", () => {
    const p = singleBuilding(12, 2.8); // 깊이 12m
    const bb = bbox(readLines(buildDxfTextForView(p, null, "east")));
    expect(bb.w).toBeCloseTo(12_000, 1);
    expect(bb.h).toBeCloseTo(33_600, 1);
  });

  it("서측 입면은 동측의 거울상 — 폭·높이는 같다", () => {
    const p = singleBuilding(10, 3);
    const e = bbox(readLines(buildDxfTextForView(p, null, "east")));
    const wv = bbox(readLines(buildDxfTextForView(p, null, "west")));
    expect(wv.w).toBeCloseTo(e.w, 1);
    expect(wv.h).toBeCloseTo(e.h, 1);
  });

  it("층고가 바뀌면 입면 높이가 그만큼 달라진다", () => {
    const a = bbox(readLines(buildDxfTextForView(singleBuilding(10, 2.8), null, "south")));
    const b = bbox(readLines(buildDxfTextForView(singleBuilding(10, 3.5), null, "south")));
    expect(a.h).toBeCloseTo(28_000, 1);
    expect(b.h).toBeCloseTo(35_000, 1);
  });

  it("입면에 층선이 들어간다 — 외곽 4변 + (층수-1)개", () => {
    const floors = 12;
    const lines = readLines(buildDxfTextForView(singleBuilding(floors, 2.8), null, "south"));
    // 수평선(층선 + 상하 외곽) = 2 + (floors - 1)
    const horizontal = lines.filter((l) => Math.abs(l.a.y - l.b.y) < 1e-6);
    expect(horizontal).toHaveLength(2 + (floors - 1));
  });

  it("아이소는 프리즘 와이어프레임 — footprint 변마다 하단·상단·수직 3선", () => {
    const p = singleBuilding(10, 3);
    const edges = p.buildings[0].footprint.length;
    const lines = readLines(buildDxfTextForView(p, null, "iso"));
    expect(lines).toHaveLength(edges * 3);
  });

  it("아이소 등각투영은 세 축을 같은 비율로 줄인다 — 높이차가 그대로 반영", () => {
    const low = bbox(readLines(buildDxfTextForView(singleBuilding(5, 3), null, "iso")));
    const high = bbox(readLines(buildDxfTextForView(singleBuilding(10, 3), null, "iso")));
    // 5층(15m) → 10층(30m): 늘어난 높이 15m가 세로 범위에 그대로 더해진다
    expect(high.h - low.h).toBeCloseTo(15_000, 1);
  });

  it("레이어가 평면과 같은 규약으로 구분된다 (계획주동·인접건물·오버레이)", () => {
    const p = mkProject();
    for (const view of ["south", "east", "west", "iso"] as const) {
      const dxf = buildDxfTextForView(p, null, view);
      const layers = new Set(readLines(dxf).map((l) => l.layer));
      expect(layers).toContain("PLAN_A_1_12F"); // 계획주동 — 동별 레이어
      expect(layers).toContain("ADJ_BLDG_5F"); // 인접건물
      expect(layers).toContain("SITE_BOUNDARY");
      expect(layers).toContain("ROAD_CL");
      // LAYER 테이블에도 등재되어야 CAD에서 레이어로 켜고 끌 수 있다
      for (const name of layers) expect(dxf).toContain(`\r\n2\r\n${name}\r\n`);
    }
  });

  it("모든 시점이 mm 단위($INSUNITS=4) R12로 나간다", () => {
    const p = mkProject();
    for (const view of ["top", "south", "east", "west", "iso"] as const) {
      const dxf = buildDxfTextForView(p, null, view);
      expect(dxf).toContain("$INSUNITS");
      expect(dxf).toContain("AC1009");
      expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    }
  });

  it("M7 지형 G.L.이 있으면 입면이 그 표고 위에 앉는다", () => {
    const p = singleBuilding(10, 3);
    p.buildings[0].terrainElevation = 12.5;
    const bb = bbox(readLines(buildDxfTextForView(p, null, "south")));
    expect(bb.minY).toBeCloseTo(12_500, 1);
    expect(bb.maxY).toBeCloseTo(12_500 + 30_000, 1);
  });

  it("회전한 동은 입면 폭이 투영 폭으로 줄어든다", () => {
    const straight = singleBuilding(10, 3);
    const turned = singleBuilding(10, 3);
    turned.buildings[0].offset.rotation = 90; // 44×12 → 남측에서 보면 12m 폭
    const a = bbox(readLines(buildDxfTextForView(straight, null, "south")));
    const b = bbox(readLines(buildDxfTextForView(turned, null, "south")));
    expect(a.w).toBeCloseTo(44_000, 1);
    expect(b.w).toBeCloseTo(12_000, 1);
  });
});
