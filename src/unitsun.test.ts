import { describe, expect, it } from "vitest";
import { runUnitSun, unitSunPasses, unitSunPoints } from "./unitsun";
import { mkBuilding, mkProject, rect } from "./testutil";
import type { AnalysisContext } from "./analyses";

function ctxOf(p: ReturnType<typeof mkProject>): AnalysisContext {
  return {
    project: p,
    viewer: null as never,
    elevate: () => undefined,
    setStatus: () => {},
    changed: () => {},
    flyTo: () => {},
    extras: {},
  };
}

describe("계획 세대 일조 확보율", () => {
  it("측정점은 필로티 위 주거층 × 창 수", () => {
    const b = mkBuilding("A", "계획주동", rect(0, 0, 30, 10), 10, {
      pilotiFloors: 1,
      // 남측 벽(y=0)에 창 3개
      windowSegments: [
        [{ x: 2, y: 0 }, { x: 8, y: 0 }],
        [{ x: 12, y: 0 }, { x: 18, y: 0 }],
        [{ x: 22, y: 0 }, { x: 28, y: 0 }],
      ],
    });
    const pts = unitSunPoints(b, 1.2);
    expect(pts.length).toBe(9 * 3);
    expect(Math.min(...pts.map((p) => p.floor))).toBe(2);
    // 남향 창 → 바깥 법선 three z+ (DXF y-)
    expect(pts[0].normal.z).toBeGreaterThan(0.99);
  });

  it("판정 규칙", () => {
    expect(unitSunPasses("continuous", 2, 1)).toBe(true);
    expect(unitSunPasses("continuous", 1.9, 6)).toBe(false);
    expect(unitSunPasses("total", 1, 4)).toBe(true);
    expect(unitSunPasses("either", 0.5, 4.2)).toBe(true);
  });

  it("앞 동에 가린 저층은 미달, 고층은 확보 — 동지", async () => {
    const win: [{ x: number; y: number }, { x: number; y: number }][] = [[{ x: 5, y: 0 }, { x: 15, y: 0 }]];
    const back = mkBuilding("뒷동", "계획주동", rect(0, 0, 20, 10), 15, { windowSegments: win });
    // 남쪽 20m 앞에 15층 동
    const front = mkBuilding("앞동", "인접건물", rect(-20, -30, 40, -20), 15);
    const r = await runUnitSun(ctxOf(mkProject([back, front])), "continuous", 0.5, 1.2, () => {});
    expect(r.points.length).toBe(15);
    const low = r.points.find((p) => p.floor === 1)!;
    const high = r.points.find((p) => p.floor === 15)!;
    expect(low.pass).toBe(false);
    expect(high.pass).toBe(true);
    expect(r.buildings[0].points).toBe(15);
  });
});
