import { describe, expect, it } from "vitest";
import { classifyLayer, diagnoseDxfText } from "./dxfdiag";

describe("도면 진단표", () => {
  it("레이어 분류", () => {
    expect(classifyLayer("PLAN_A_1")).toBe("계획주동 외곽선");
    expect(classifyLayer("plan_win")).toBe("창 표시 (계획주동)");
    expect(classifyLayer("ADJ_BOUNDARY")).toBe("인접대지경계");
    expect(classifyLayer("ADJ_BLDG_3F")).toBe("인접건물 외곽선");
    expect(classifyLayer("CONTOUR_35")).toBe("등고선");
    expect(classifyLayer("A-WALL")).toMatch(/^미인식/);
  });

  it("ENTITIES 섹션만 세고 VERTEX·SEQEND는 제외", () => {
    const dxf = [
      "0", "SECTION", "2", "BLOCKS", "0", "LINE", "8", "IN_BLOCK", "0", "ENDSEC",
      "0", "SECTION", "2", "ENTITIES",
      "0", "LWPOLYLINE", "8", "PLAN_A_1",
      "0", "POLYLINE", "8", "ADJ_BLDG", "0", "VERTEX", "8", "ADJ_BLDG", "0", "SEQEND", "8", "ADJ_BLDG",
      "0", "LINE", "8", "A-WALL",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n");
    const d = diagnoseDxfText(dxf);
    expect(d.totalEntities).toBe(3);
    expect(d.layers.map((l) => l.layer).sort()).toEqual(["A-WALL", "ADJ_BLDG", "PLAN_A_1"]);
    expect(d.layers.find((l) => l.layer === "ADJ_BLDG")!.count).toBe(1);
    expect(d.layers[d.layers.length - 1].category).toMatch(/^미인식/);
  });
});
