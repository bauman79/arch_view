import { describe, expect, it } from "vitest";
import { classifyPoint, facilityFloorRange, runFacilityCheck, windowAnchors } from "./facility";
import { parseUseText } from "./dxf";
import { defaultProject, type Building, type Point2, type Project } from "./types";

function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

function mk(id: string, type: "계획주동" | "인접건물", fp: Point2[], floors: number): Building {
  return {
    id, name: id, type, massType: "custom", footprint: fp, floors, floorHeight: 3.3,
    pilotiFloors: 0, unitsPerFloor: 0, segments: 1, unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 }, analysisTarget: type === "계획주동",
    mirroredH: false, mirroredV: false, windowSegments: [],
  };
}

function mkProject(bs: Building[]): Project {
  const p = defaultProject();
  p.buildings = bs;
  p.analysis.date = "2026-12-21";
  return p;
}

/** 3층 유치원 — 남쪽 벽(y=0)에 창 2개 */
function kinder(): Building {
  const b = mk("kinder", "인접건물", rect(0, 0, 20, 10), 3);
  b.use = "kindergarten";
  b.windowSegments = [
    [{ x: 3, y: 0 }, { x: 7, y: 0 }],
    [{ x: 13, y: 0 }, { x: 17, y: 0 }],
  ];
  return b;
}

describe("parseUseText", () => {
  it("한글·영문 용도 문자", () => {
    expect(parseUseText("유치원")).toBe("kindergarten");
    expect(parseUseText("KINDER")).toBe("kindergarten");
    expect(parseUseText("{\\fArial;초등학교}")).toBe("school");
    expect(parseUseText("church")).toBe("church");
    expect(parseUseText("교회")).toBe("church");
    expect(parseUseText("근린생활시설")).toBeNull();
  });
});

describe("classifyPoint", () => {
  it("사업 후 확보 → ok", () => {
    expect(classifyPoint({ continuous: 3, total: 5 }, { continuous: 2, total: 3 })).toBe("ok");
  });
  it("사업 전 확보 → 사업 후 미달 → project", () => {
    expect(classifyPoint({ continuous: 3, total: 5 }, { continuous: 1, total: 2 })).toBe("project");
  });
  it("사업 전부터 미달 + 더 줄어듦 → worse, 변화 없음 → existing", () => {
    expect(classifyPoint({ continuous: 1, total: 3 }, { continuous: 0.5, total: 3 })).toBe("worse");
    expect(classifyPoint({ continuous: 1, total: 3 }, { continuous: 1, total: 3 })).toBe("existing");
  });
});

describe("windowAnchors · facilityFloorRange", () => {
  it("창 법선은 건물 바깥(남쪽)을 향한다", () => {
    const a = windowAnchors(kinder());
    expect(a).toHaveLength(2);
    expect(a[0].mid).toEqual({ x: 5, y: 0 });
    expect(a[0].n.y).toBeCloseTo(-1);
  });
  it("교실 층 범위는 전 층 안으로 맞춘다", () => {
    const b = kinder();
    expect(facilityFloorRange(b)).toEqual([1, 3]);
    b.classFloors = { from: 2, to: 9 };
    expect(facilityFloorRange(b)).toEqual([2, 3]);
  });
});

describe("runFacilityCheck — 사업 전·후 비교", () => {
  it("차폐 없으면 모든 창·층 확보, 사업 영향 없음", async () => {
    const r = await runFacilityCheck(mkProject([kinder()]));
    expect(r.points).toHaveLength(6); // 창 2 × 3층
    expect(r.points.every((p) => p.status === "ok")).toBe(true);
    expect(r.summaries[0].affected).toBe(false);
  });

  it("남쪽 가까이 고층 계획주동 → 저층은 사업으로 미달, 사업 전은 확보", async () => {
    const plan = mk("plan", "계획주동", rect(-20, -30, 40, -18), 20);
    const r = await runFacilityCheck(mkProject([kinder(), plan]));
    const f1 = r.points.filter((p) => p.floor === 1);
    expect(f1.every((p) => p.status === "project")).toBe(true);
    expect(f1.every((p) => p.before.total >= 4)).toBe(true);
    expect(r.summaries[0].affected).toBe(true);
    expect(r.summaries[0].byFloor[0].counts.project).toBe(2);
  });

  it("기존 건물이 이미 가리면 '기존 미달' — 사업 탓이 아니다", async () => {
    const existing = mk("old", "인접건물", rect(-20, -30, 40, -18), 20);
    const plan = mk("plan", "계획주동", rect(200, 200, 210, 210), 5); // 멀리 떨어진 계획동
    const r = await runFacilityCheck(mkProject([kinder(), existing, plan]));
    const f1 = r.points.filter((p) => p.floor === 1);
    expect(f1.every((p) => p.status === "existing")).toBe(true);
    expect(r.summaries[0].affected).toBe(false);
  });

  it("교실 층만 측정 · 창 없는 시설은 noWindows로 알린다", async () => {
    const k = kinder();
    k.classFloors = { from: 2, to: 3 };
    const church = mk("church", "인접건물", rect(50, 0, 60, 10), 2);
    church.use = "church";
    const r = await runFacilityCheck(mkProject([k, church]));
    expect(r.points.every((p) => p.floor >= 2)).toBe(true);
    expect(r.points).toHaveLength(4);
    expect(r.noWindows).toEqual(["church"]);
  });
});
