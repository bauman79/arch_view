import { describe, expect, it } from "vitest";
import { mirrorBuilding } from "./buildings";
import { edgeHasWindow } from "./windows";
import type { Building, Point2 } from "./types";

/**
 * 미러 시 footprint와 windowSegments가 함께 반전되는지 — 창면 정합 불변식 회귀 테스트.
 * (과거 버그: footprint만 반전되어 창면 하이라이트·채광사선·인동거리 창 판정이
 * 반대편 벽으로 어긋났음 — 화면상 창면이 주동에서 떨어져 표시되는 증상.)
 */

function mkBuilding(footprint: Point2[]): Building {
  return {
    id: "t-1",
    name: "테스트동",
    type: "계획주동",
    massType: "custom",
    footprint,
    floors: 10,
    floorHeight: 2.8,
    pilotiFloors: 0,
    unitsPerFloor: 4,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: true,
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

/** 모든 windowSegment가 footprint의 어떤 에지와 일치하는지 (정합 불변식) */
function windowsAttached(b: Building): boolean {
  const n = b.footprint.length;
  return b.windowSegments.every(([wa, wb]) => {
    for (let i = 0; i < n; i++) {
      if (edgeHasWindow(b.footprint[i], b.footprint[(i + 1) % n], [[wa, wb]])) return true;
    }
    return false;
  });
}

describe("mirrorBuilding — 창면 정합 불변식", () => {
  // 비대칭 L자 footprint — 반전하면 모양이 실제로 바뀌는 케이스
  const L: Point2[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 6 },
    { x: 8, y: 6 },
    { x: 8, y: 12 },
    { x: 0, y: 12 },
  ];

  it("좌우반전(h) 후에도 창면이 footprint 에지에 붙어 있다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [
      [{ x: 0, y: 0 }, { x: 20, y: 0 }], // 남측 벽
      [{ x: 8, y: 6 }, { x: 8, y: 12 }], // 안쪽 세로 벽
    ];
    expect(windowsAttached(b)).toBe(true);
    mirrorBuilding(b, "h");
    expect(b.mirroredH).toBe(true);
    expect(windowsAttached(b)).toBe(true); // 과거 버그에선 false
  });

  it("상하반전(v) 후에도 창면이 footprint 에지에 붙어 있다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [[{ x: 0, y: 0 }, { x: 20, y: 0 }]];
    mirrorBuilding(b, "v");
    expect(b.mirroredV).toBe(true);
    expect(windowsAttached(b)).toBe(true);
  });

  it("같은 축으로 두 번 반전하면 원상복구된다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [[{ x: 0, y: 0 }, { x: 20, y: 0 }]];
    mirrorBuilding(b, "h");
    mirrorBuilding(b, "h");
    expect(b.mirroredH).toBe(false);
    // 부동소수점 오차 허용 비교
    expect(b.windowSegments[0][0].x).toBeCloseTo(0, 9);
    expect(b.windowSegments[0][1].x).toBeCloseTo(20, 9);
    expect(windowsAttached(b)).toBe(true);
  });
});
