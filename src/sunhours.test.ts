import { describe, expect, it } from "vitest";
import { faceLabel } from "./pv";
import { findRoadFacingWalls, judgeBuilding, passesRule, runSunHoursCheck } from "./sunhours";
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

/**
 * 도로 접면 판정 — 인접건물의 도로 쪽 벽만 판정하고 동 단위는 확보율로 가른다.
 * rect()는 남(0)→동(1)→북(2)→서(3) 순으로 변이 이어진다.
 */
describe("도로 접면 판정", () => {
  const roadArea = (pts: Point2[]) => ({ layer: "ROAD_AREA" as const, points: pts, closed: true });

  it("남쪽 도로(ROAD_AREA)에 면한 벽만 도로 접면", () => {
    const adj = mkBuilding("a", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const r = findRoadFacingWalls([adj], [roadArea(rect(-20, -10, 30, -2))]); // 건물 남쪽 2~10m
    expect(r.source).toBe("ROAD_AREA");
    expect([...(r.walls.get("a") ?? [])]).toEqual([0]);
  });

  it("사이에 다른 건물이 막고 있으면 도로 접면이 아니다", () => {
    const adj = mkBuilding("a", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const front = mkBuilding("b", "인접건물", rect(-5, -4, 15, -1), 3, 3); // 도로와 사이를 가로막음
    const r = findRoadFacingWalls([adj, front], [roadArea(rect(-20, -12, 30, -6))]);
    expect(r.walls.get("a")?.has(0) ?? false).toBe(false);
    expect(r.walls.get("b")?.has(0)).toBe(true); // 앞 건물의 남쪽 벽은 도로 접면
  });

  it("ROAD_AREA가 없으면 도로중심선(ROAD_CL)을 가로지르는지로 판정", () => {
    const adj = mkBuilding("a", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const cl = { layer: "ROAD_CL" as const, points: [{ x: -30, y: -8 }, { x: 40, y: -8 }], closed: false };
    const r = findRoadFacingWalls([adj], [cl]);
    expect(r.source).toBe("ROAD_CL");
    expect([...(r.walls.get("a") ?? [])]).toEqual([0]);
  });

  it("도로 정보가 없으면 판정 근거 없음(source=null)", () => {
    const adj = mkBuilding("a", "인접건물", rect(0, 0, 10, 10), 3, 3);
    expect(findRoadFacingWalls([adj], []).source).toBeNull();
  });

  it("검토는 도로 쪽 벽에만 셀을 만들고 지붕은 빼며, 도로 없는 동은 판정 제외로 센다", async () => {
    const front = mkBuilding("front", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const back = mkBuilding("back", "인접건물", rect(0, 40, 10, 50), 3, 3); // 도로에서 30m — 접면 없음
    const p = mkProject([front, back]);
    p.siteOverlays = [roadArea(rect(-20, -10, 30, -2))];
    const r = await runSunHoursCheck(p);
    expect(r.roadFacingOnly).toBe(true);
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.cells.every((c) => c.buildingId === "front" && c.surface === "wall")).toBe(true);
    expect(r.cells.every((c) => c.normal.z > 0.99)).toBe(true); // three +z = 남쪽 → 남향 벽만
    expect(r.excludedBuildings).toBe(1);
  });

  it("설정을 끄면 예전처럼 전체 벽·지붕", async () => {
    const adj = mkBuilding("a", "인접건물", rect(0, 0, 10, 10), 3, 3);
    const p = mkProject([adj]);
    p.siteOverlays = [roadArea(rect(-20, -10, 30, -2))];
    p.analysis.sunHours.roadFacingOnly = false;
    const r = await runSunHoursCheck(p);
    expect(r.roadFacingOnly).toBe(false);
    expect(r.cells.some((c) => c.surface === "roof")).toBe(true);
  });

  it("judgeBuilding — 확보율이 기준 이상이면 확보, 셀 없으면 판정 제외", () => {
    const s = (pass: number, total: number) => ({
      buildingId: "x", name: "x",
      wall: { passCells: pass, totalCells: total },
      roof: { passCells: 0, totalCells: 0 },
    });
    expect(judgeBuilding(s(5, 10), 0.5)).toBe("pass");
    expect(judgeBuilding(s(4, 10), 0.5)).toBe("fail");
    expect(judgeBuilding(s(9, 10), 1)).toBe("fail"); // 예전 기준(셀 전부)
    expect(judgeBuilding(s(0, 0), 0.5)).toBe("na");
  });
});
