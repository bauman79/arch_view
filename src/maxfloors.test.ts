import { describe, expect, it } from "vitest";
import { failingRule, findMaxFloors, planTypeOf } from "./maxfloors";
import { mkBuilding, mkProject, rect } from "./testutil";

describe("법규 최대 층수", () => {
  it("타입 추출", () => {
    expect(planTypeOf("계획주동_A_1")).toBe("A");
    expect(planTypeOf("계획주동_b2_12")).toBe("B2");
    expect(planTypeOf("샘플")).toBe("기타");
  });

  it("기준선·마주 보는 동이 없으면 한도까지", async () => {
    const p = mkProject([mkBuilding("A", "계획주동", rect(0, 0, 30, 12), 1, { name: "계획주동_A_1" })]);
    const r = await findMaxFloors(p, ["A"], 25);
    expect(r[0].max).toBe(25);
    expect(r[0].limit).toBe("한도");
  });

  it("창을 마주 보는 두 동(30m) — 인동거리로 제한되고, 결과 층수는 적합·한 층 더는 위반", async () => {
    const a = mkBuilding("A", "계획주동", rect(0, 0, 30, 12), 1, {
      name: "계획주동_A_1",
      windowSegments: [[{ x: 25, y: 12 }, { x: 5, y: 12 }]],
    });
    const b = mkBuilding("B", "계획주동", rect(0, 42, 30, 54), 1, {
      name: "계획주동_A_2",
      windowSegments: [[{ x: 5, y: 42 }, { x: 25, y: 42 }]],
    });
    const p = mkProject([a, b]);
    const r = await findMaxFloors(p, ["A", "B"], 60);
    for (const x of r) {
      expect(x.limit).toBe("인동거리");
      expect(x.max).toBeLessThan(60);
      expect(x.max).toBeGreaterThan(5);
    }
    // 찾은 층수는 적합, 한 동만 한 층 더 올리면 위반
    expect(failingRule(p, a)).toBeNull();
    a.floors += 1;
    expect(failingRule(p, a)).toBe("인동거리");
  });
});
