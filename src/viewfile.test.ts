import { describe, expect, it } from "vitest";
import { createTemplateBuilding } from "./massing";
import { defaultProject } from "./types";
import { deserializeView, serializeView } from "./viewfile";

/** .view 저장/불러오기 — 직렬화 라운드트립과 손상 파일 방어 */

function mkProject() {
  const p = defaultProject();
  const b = createTemplateBuilding("slab", 4, 1, 1);
  b.offset = { dx: 12, dy: -7, rotation: 30 };
  b.windowSegments = [[{ x: -22, y: -6 }, { x: 22, y: -6 }]];
  p.buildings.push(b);
  p.buildingLibrary.push(createTemplateBuilding("tower", 6, 1, 2));
  p.siteOverlays = [
    { layer: "SITE_BOUNDARY", closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
  ];
  p.site.siteAreaM2 = 4321;
  p.analysis.gridSize = 2;
  return p;
}

describe(".view 직렬화 라운드트립", () => {
  it("프로젝트 상태가 그대로 복원된다", () => {
    const p = mkProject();
    const text = serializeView(p, { x: 100, y: 200 }, { dxfLoadSeq: 3, sceneSeq: 7 });
    const v = deserializeView(text);
    expect(v.sceneOrigin).toEqual({ x: 100, y: 200 });
    expect(v.counters).toEqual({ dxfLoadSeq: 3, sceneSeq: 7 });
    expect(v.buildings).toHaveLength(1);
    expect(v.buildings[0].offset).toEqual({ dx: 12, dy: -7, rotation: 30 });
    expect(v.buildings[0].windowSegments).toHaveLength(1);
    expect(v.buildingLibrary).toHaveLength(1);
    expect(v.siteOverlays[0].layer).toBe("SITE_BOUNDARY");
    expect(v.site.siteAreaM2).toBe(4321);
    expect(v.analysis.gridSize).toBe(2);
  });

  it("JSON이 아니면 한국어 메시지로 거부", () => {
    expect(() => deserializeView("not json")).toThrow(/JSON 파싱 실패/);
  });

  it("다른 JSON 파일이면 format 표식으로 거부", () => {
    expect(() => deserializeView('{"hello": 1}')).toThrow(/format 표식/);
  });

  it("미래 버전이면 업데이트 안내", () => {
    const text = serializeView(mkProject(), null, { dxfLoadSeq: 0, sceneSeq: 0 });
    const bumped = text.replace('"version": 1', '"version": 999');
    expect(() => deserializeView(bumped)).toThrow(/지원하지 않는/);
  });

  it("footprint가 깨진 건물이 있으면 거부", () => {
    const p = mkProject();
    (p.buildings[0] as any).footprint = [];
    const text = serializeView(p, null, { dxfLoadSeq: 0, sceneSeq: 0 });
    expect(() => deserializeView(text)).toThrow(/footprint 이상/);
  });
});
