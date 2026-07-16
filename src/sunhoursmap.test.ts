import { describe, expect, it } from "vitest";
import { runSunHoursMap, SUNMAP_GRID_M } from "./sunhoursmap";
import { defaultProject, type Building, type Point2, type Project } from "./types";

/**
 * M9 일조시간 지도 검증 — 동지(서울) 지면 격자의 무차폐/차폐 대조와
 * 법적기준(연속2h/총4h) 참고 판정. sunhours.test.ts(M2.1 수인한도)와 같은
 * 남/북 대조 패턴을 지면 셀에 적용한다.
 */

function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function mkBuilding(
  id: string,
  footprint: Point2[],
  floors: number,
  floorHeight = 3,
): Building {
  return {
    id,
    name: id,
    type: "인접건물", // analysisTarget=false — 표면 격자 없이 차폐(그림자)만 만든다
    massType: "custom",
    footprint,
    floors,
    floorHeight,
    pilotiFloors: 0,
    unitsPerFloor: 0,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: false,
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

function mkProject(buildings: Building[]): Project {
  const p = defaultProject();
  p.buildings = buildings;
  p.analysis.date = "2026-12-21"; // 동지, 서울
  return p;
}

/** pos(three 좌표)와 도면 좌표(x, y)가 가장 가까운 지면 셀 */
function groundCellAt(cells: { pos: { x: number; z: number }; isGround: boolean }[], x: number, y: number) {
  const ground = cells.filter((c) => c.isGround);
  expect(ground.length).toBeGreaterThan(0);
  let best = ground[0];
  let bestD = Infinity;
  for (const c of ground) {
    const d = Math.hypot(c.pos.x - x, -c.pos.z - y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  expect(bestD).toBeLessThanOrEqual(SUNMAP_GRID_M);
  return best as any;
}

// 동서로 긴 고층 벽체 — 남측 지면은 무차폐, 북측 지면은 하루 종일 그림자
const wall = () => mkBuilding("wall", rect(-30, 0, 30, 10), 20); // H=60m

describe("runSunHoursMap — 동지 시간 계산 (서울)", () => {
  it("건물 남측 무차폐 지면은 8~16시 17스텝 전부 양지 = 8.5h", async () => {
    const r = await runSunHoursMap(mkProject([wall()]), "동지");
    expect(r.dates).toEqual(["2026-12-21"]);
    const cell = groundCellAt(r.cells, 0, -10); // 남측 10m
    expect(cell.hours).toBeCloseTo(8.5, 6);
    expect(r.stats.max).toBeCloseTo(8.5, 6);
  });

  it("높은 벽체 바로 북측 지면은 동지 직달 0h", async () => {
    const r = await runSunHoursMap(mkProject([wall()]), "동지");
    const cell = groundCellAt(r.cells, 0, 13); // 북측 벽에서 3m
    expect(cell.hours).toBe(0);
    expect(r.stats.min).toBe(0);
  });
});

describe("runSunHoursMap — 법적기준(연속2h/총4h) 판정", () => {
  it("무차폐 남측 지면 셀은 연속2h·총4h 모두 충족", async () => {
    const r = await runSunHoursMap(mkProject([wall()]), "동지");
    const cell = groundCellAt(r.cells, 0, -10);
    expect(cell.passContinuous).toBe(true);
    expect(cell.passTotal).toBe(true);
    expect(cell.continuousHours).toBeGreaterThanOrEqual(2);
    expect(cell.totalHours).toBeGreaterThanOrEqual(4);
    expect(r.legalCheck.continuous2h.pass).toBeGreaterThan(0);
    expect(r.legalCheck.total4h.pass).toBeGreaterThan(0);
  });

  it("종일 그림자 셀은 둘 다 미달 — 집계 pass+fail = 전체 셀 수", async () => {
    const r = await runSunHoursMap(mkProject([wall()]), "동지");
    const cell = groundCellAt(r.cells, 0, 13);
    expect(cell.passContinuous).toBe(false);
    expect(cell.passTotal).toBe(false);
    expect(cell.continuousHours).toBe(0);
    expect(cell.totalHours).toBe(0);
    const n = r.cells.length;
    expect(r.legalCheck.continuous2h.pass + r.legalCheck.continuous2h.fail).toBe(n);
    expect(r.legalCheck.total4h.pass + r.legalCheck.total4h.fail).toBe(n);
    expect(r.legalCheck.continuous2h.fail).toBeGreaterThan(0);
  });
});

describe("runSunHoursMap — 연평균", () => {
  it("연평균은 4개 대표일을 평균하고 법적기준은 동지로 판정한다", async () => {
    const r = await runSunHoursMap(mkProject([wall()]), "연평균");
    expect(r.dates).toHaveLength(4);
    expect(r.legalDate).toBe("2026-12-21");
    // 북측 3m 지면: 동지 0h이지만 하지에는 해가 들어 연평균 > 0
    const north = groundCellAt(r.cells, 0, 13);
    expect(north.totalHours).toBe(0); // 법적기준(동지) 누적은 0
    expect(north.hours).toBeGreaterThan(0); // 연평균 시간은 0보다 큼
  });
});
