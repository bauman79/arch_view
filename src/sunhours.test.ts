import { describe, expect, it } from "vitest";
import { faceLabel } from "./pv";
import { passesRule, runSunHoursCheck } from "./sunhours";
import { defaultProject, type Building, type Point2, type Project } from "./types";

/**
 * 일조권(수인한도) 검토 검증 — 대법원 판례 기준 09~15시 연속 2h 이상 또는 08~16시
 * 총 4h 이상. 정북사선(순수 기하)과 달리 실제 태양 위치 레이캐스팅이 필요해
 * pv.test.ts와 같은 검증 방식(무차폐 남/북향 대조, 차폐 건물 배치)을 따른다.
 */

function mkBuilding(
  id: string,
  type: "계획주동" | "인접건물",
  footprint: Point2[],
  floors: number,
  floorHeight: number,
): Building {
  return {
    id,
    name: id,
    type,
    massType: "custom",
    footprint,
    floors,
    floorHeight,
    pilotiFloors: 0,
    unitsPerFloor: 0,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: type === "계획주동",
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function mkProject(buildings: Building[]): Project {
  const p = defaultProject();
  p.buildings = buildings;
  p.analysis.gridSize = 3; // 테스트 속도용 — 큰 격자
  p.analysis.date = "2026-12-21"; // 동지, 서울 — 남중고도 낮아 남/북 대비 뚜렷
  return p;
}

describe("passesRule — 손계산 대조", () => {
  it("continuous 기준: 연속 2h 이상만 본다", () => {
    expect(passesRule("continuous", 2.0, 0)).toBe(true);
    expect(passesRule("continuous", 1.9, 10)).toBe(false); // total 충분해도 무시
  });
  it("total 기준: 누적 4h 이상만 본다", () => {
    expect(passesRule("total", 0, 4.0)).toBe(true);
    expect(passesRule("total", 5, 3.9)).toBe(false); // continuous 충분해도 무시
  });
  it("either 기준: 둘 중 하나만 충족해도 적합", () => {
    expect(passesRule("either", 2.0, 0)).toBe(true);
    expect(passesRule("either", 0, 4.0)).toBe(true);
    expect(passesRule("either", 1.9, 3.9)).toBe(false);
  });
});

describe("runSunHoursCheck — 대상·격자", () => {
  it("검토 대상은 인접건물뿐 — 계획주동에는 셀이 생기지 않는다", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 5, 3);
    const plan = mkBuilding("plan-1", "계획주동", rect(30, 0, 40, 10), 10, 3);
    const r = await runSunHoursCheck(mkProject([adj, plan]));
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.cells.every((c) => c.buildingId === "adj-1")).toBe(true);
    expect(r.summaries).toHaveLength(1);
    expect(r.summaries[0].buildingId).toBe("adj-1");
  });

  it("인접건물이 없으면 셀 0개, 요약도 빈 배열", async () => {
    const plan = mkBuilding("plan-1", "계획주동", rect(0, 0, 10, 10), 10, 3);
    const r = await runSunHoursCheck(mkProject([plan]));
    expect(r.cells).toHaveLength(0);
    expect(r.summaries).toHaveLength(0);
  });

  it("08~16시를 timeStep 간격으로 샘플링한다(기본 10분 → 48개)", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const r = await runSunHoursCheck(mkProject([adj]));
    expect(r.timeStep).toBe(10);
    expect(r.samples).toHaveLength(48);
  });
});

describe("runSunHoursCheck — 무차폐 남/북향 대조 (동지, 서울)", () => {
  it("무차폐 남향 벽은 연속2h·총4h 모두 넉넉히 충족 → 적합", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const r = await runSunHoursCheck(mkProject([adj]));
    const south = r.cells
      .map((c, i) => ({ c, res: r.results[i] }))
      .filter(({ c }) => c.surface === "wall" && faceLabel(c, 0) === "남측 벽면");
    expect(south.length).toBeGreaterThan(0);
    for (const { res } of south) {
      expect(res.pass).toBe(true);
      expect(res.continuousHours).toBeGreaterThanOrEqual(2);
      expect(res.totalHours).toBeGreaterThanOrEqual(4);
    }
  });

  it("무차폐 북향 벽은 동지 직달이 전혀 없어 위반", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const r = await runSunHoursCheck(mkProject([adj]));
    const north = r.cells
      .map((c, i) => ({ c, res: r.results[i] }))
      .filter(({ c }) => c.surface === "wall" && faceLabel(c, 0) === "북측 벽면");
    expect(north.length).toBeGreaterThan(0);
    for (const { res } of north) {
      expect(res.pass).toBe(false);
      expect(res.continuousHours).toBe(0);
      expect(res.totalHours).toBe(0);
    }
  });
});

describe("runSunHoursCheck — 차폐 반영", () => {
  it("남측에 높은 계획주동이 서면 인접건물 남향 벽이 적합→위반으로 바뀐다", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 3, 3); // H=9
    // 남측 4m 거리에 45m 높이 차폐건물(동서로 여유 있게 넓혀 저녁·아침 측면 광선까지 차단)
    // — 동지 최대고도(~29°)보다 훨씬 가파른 각
    const blocker = mkBuilding("blocker", "계획주동", rect(-15, -14, 25, -4), 15, 3); // H=45
    const r = await runSunHoursCheck(mkProject([adj, blocker]));
    const south = r.cells
      .map((c, i) => ({ c, res: r.results[i] }))
      .filter(
        ({ c }) =>
          c.buildingId === "adj-1" && c.surface === "wall" && faceLabel(c, 0) === "남측 벽면",
      );
    expect(south.length).toBeGreaterThan(0);
    for (const { res } of south) {
      expect(res.pass).toBe(false);
      expect(res.totalHours).toBeCloseTo(0, 6);
    }
  });
});

describe("runSunHoursCheck — summaries 집계", () => {
  it("벽면·지붕 passCells/totalCells가 실제 셀 판정과 일치한다", async () => {
    const adj = mkBuilding("adj-1", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const r = await runSunHoursCheck(mkProject([adj]));
    const s = r.summaries[0];
    const wallCells = r.cells
      .map((c, i) => ({ c, res: r.results[i] }))
      .filter(({ c }) => c.surface === "wall");
    const roofCells = r.cells
      .map((c, i) => ({ c, res: r.results[i] }))
      .filter(({ c }) => c.surface === "roof");
    expect(s.wall.totalCells).toBe(wallCells.length);
    expect(s.wall.passCells).toBe(wallCells.filter((x) => x.res.pass).length);
    expect(s.roof.totalCells).toBe(roofCells.length);
    expect(s.roof.passCells).toBe(roofCells.filter((x) => x.res.pass).length);
  });
});
