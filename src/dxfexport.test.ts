import { describe, expect, it } from "vitest";
import { parseDxfBuildings } from "./dxf";
import { buildDxfText } from "./dxfexport";
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
