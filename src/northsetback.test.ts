import { describe, expect, it } from "vitest";
import { allowedHeightFromDistance, runNorthSetbackCheck } from "./northsetback";
import { defaultProject, type Building, type Point2, type Project } from "./types";

/**
 * 정북사선 검토 손계산 대조표 — 건축법 시행령 제86조 제1항 **현행 기준**
 * (높이 10m 이하 부분: 1.5m 이상 이격 / 10m 초과 부분: 높이×0.5 이상 이격).
 * 거리 D에서의 허용높이 = D < 1.5m ? 0 : max(10, 2×D).
 *
 * | 케이스 | 손계산 기대값 |
 * |---|---|
 * | D=1.0 (<1.5)  | 허용 0m — 어떤 높이도 불가 |
 * | D=1.5 (경계)  | 허용 max(10, 3) = 10m |
 * | D=3           | 허용 max(10, 6) = 10m (저층부 기준이 지배) |
 * | D=6           | 허용 max(10, 12) = 12m |
 * | D=20          | 허용 max(10, 40) = 40m |
 *
 * ⚠️ 거리 D는 건물 중심이 아니라 **각 부분(꼭짓점·에지 중점) 중 최솟값** — 경계선에
 * 가장 가까운 부분이 판정 기준이다.
 */

let seq = 0;
function mkPlan(footprint: Point2[], floors: number, floorHeight: number): Building {
  return {
    id: `plan-${++seq}`,
    name: `계획주동 ${seq}`,
    type: "계획주동",
    massType: "custom",
    footprint,
    floors,
    floorHeight,
    pilotiFloors: 0,
    unitsPerFloor: 0,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: true,
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

/** 계획주동 1개(10×10, 북측 벽 y=10) + 북측 벽에서 D만큼 떨어진 ADJ_BOUNDARY */
function mkProject(D: number, floors: number, floorHeight: number): Project {
  const p = defaultProject();
  const plan = mkPlan(rect(0, 0, 10, 10), floors, floorHeight);
  p.buildings = [plan];
  p.siteOverlays = [
    {
      layer: "ADJ_BOUNDARY",
      points: [
        { x: -5, y: 10 + D },
        { x: 15, y: 10 + D },
      ],
      closed: false,
    },
  ];
  return p;
}

describe("allowedHeightFromDistance — 손계산 대조 (제86조 제1항 현행)", () => {
  it("D < 1.5m: 허용높이 0", () => {
    expect(allowedHeightFromDistance(1.0, 1.5, 10, 0.5)).toBe(0);
  });
  it("D=1.5(경계): 저층부 기준 10m", () => {
    expect(allowedHeightFromDistance(1.5, 1.5, 10, 0.5)).toBeCloseTo(10, 6);
  });
  it("2×D < 10이면 저층부 기준 10m가 지배 (D=3 → 10m)", () => {
    expect(allowedHeightFromDistance(3, 1.5, 10, 0.5)).toBeCloseTo(10, 6);
  });
  it("2×D > 10이면 D÷0.5 (D=6 → 12m, D=20 → 40m)", () => {
    expect(allowedHeightFromDistance(6, 1.5, 10, 0.5)).toBeCloseTo(12, 6);
    expect(allowedHeightFromDistance(20, 1.5, 10, 0.5)).toBeCloseTo(40, 6);
  });
  it("조례 배율 변경 반영 (ratio=0.4 → D=6에서 15m)", () => {
    expect(allowedHeightFromDistance(6, 1.5, 10, 0.4)).toBeCloseTo(15, 6);
  });
});

describe("runNorthSetbackCheck — 판정", () => {
  it("D=6, H=12(=2×6) → 경계 적합", () => {
    const p = mkProject(6, 6, 2); // H=12
    const r = runNorthSetbackCheck(p);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].distance).toBeCloseTo(6, 6);
    expect(r.checks[0].allowedHeight).toBeCloseTo(12, 6);
    expect(r.checks[0].pass).toBe(true);
    expect(r.violations).toBe(0);
  });

  it("D=6, H=12.5 → 위반", () => {
    const p = mkProject(6, 5, 2.5); // H=12.5
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].pass).toBe(false);
    expect(r.violations).toBe(1);
  });

  it("D=3, H=10 → 적합 (저층부 기준), H=11 → 위반", () => {
    const ok = runNorthSetbackCheck(mkProject(3, 5, 2)); // H=10
    expect(ok.checks[0].allowedHeight).toBeCloseTo(10, 6);
    expect(ok.checks[0].pass).toBe(true);

    const bad = runNorthSetbackCheck(mkProject(3, 5, 2.2)); // H=11
    expect(bad.checks[0].pass).toBe(false);
  });

  it("D=1.0(<1.5m) → 허용 0, 어떤 높이든 위반", () => {
    const r = runNorthSetbackCheck(mkProject(1.0, 1, 3)); // H=3 (낮아도)
    expect(r.checks[0].allowedHeight).toBe(0);
    expect(r.checks[0].pass).toBe(false);
  });

  it("거리 D는 건물 중심이 아니라 가장 가까운 부분(북측 벽) 기준", () => {
    // 북측 벽 y=10, 경계 y=16 → 부분 기준 D=6 (중심 기준이었다면 11)
    const r = runNorthSetbackCheck(mkProject(6, 6, 2));
    expect(r.checks[0].distance).toBeCloseTo(6, 6);
    // 검토선 시작점은 북측 벽 위의 점이어야 한다
    expect(r.checks[0].origin.y).toBeCloseTo(10, 6);
    expect(r.checks[0].point!.y).toBeCloseTo(16, 6);
  });
});

describe("runNorthSetbackCheck — 기준선 탐색 규칙", () => {
  it("ADJ_BOUNDARY가 없으면 SITE_BOUNDARY로 대체한다", () => {
    const plan = mkPlan(rect(0, 0, 10, 10), 5, 2); // H=10
    const p = defaultProject();
    p.buildings = [plan];
    p.siteOverlays = [
      {
        layer: "SITE_BOUNDARY",
        points: rect(-20, -20, 20, 16), // 북쪽 경계 y=16 → D=6
        closed: true,
      },
    ];
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].source).toBe("SITE_BOUNDARY");
    expect(r.checks[0].distance).toBeCloseTo(6, 6);
  });

  it("ADJ_BOUNDARY와 SITE_BOUNDARY가 둘 다 있으면 ADJ_BOUNDARY를 우선 채택한다", () => {
    const plan = mkPlan(rect(0, 0, 10, 10), 5, 2);
    const p = defaultProject();
    p.buildings = [plan];
    p.siteOverlays = [
      { layer: "SITE_BOUNDARY", points: rect(-20, -20, 20, 30), closed: true }, // D=20
      {
        layer: "ADJ_BOUNDARY",
        points: [
          { x: -5, y: 16 },
          { x: 15, y: 16 },
        ],
        closed: false,
      }, // D=6
    ];
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].source).toBe("ADJ_BOUNDARY");
    expect(r.checks[0].distance).toBeCloseTo(6, 6);
  });

  it("경계선이 전혀 없으면 제한 없음(pass=true, allowedHeight=null)", () => {
    const plan = mkPlan(rect(0, 0, 10, 10), 20, 3); // H=60, 매우 높음
    const p = defaultProject();
    p.buildings = [plan];
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].distance).toBeNull();
    expect(r.checks[0].allowedHeight).toBeNull();
    expect(r.checks[0].pass).toBe(true);
  });
});

describe("runNorthSetbackCheck — 배치·정북각 반영", () => {
  it("건물 이동(offset)이 D에 반영된다", () => {
    const p = mkProject(6, 5, 2);
    p.buildings[0].offset.dy = 2; // 북쪽 2m 접근 → D=4
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].distance).toBeCloseTo(4, 6);
  });

  it("정북각(northAngle) 보정이 광선 방향에 반영된다", () => {
    // northAngle=90°면 정북 = 도면 -X 방향 — 서쪽 D=6에 경계선을 둔다
    const plan = mkPlan(rect(0, 0, 10, 10), 5, 2);
    const p = defaultProject();
    p.buildings = [plan];
    p.site.northAngle = 90;
    p.siteOverlays = [
      {
        layer: "ADJ_BOUNDARY",
        points: [
          { x: -6, y: -5 },
          { x: -6, y: 15 },
        ],
        closed: false,
      },
    ];
    const r = runNorthSetbackCheck(p);
    expect(r.checks[0].distance).toBeCloseTo(6, 6);
  });

  it("인접건물(ADJ_BLDG)은 검토 대상에서 제외된다", () => {
    const plan = mkPlan(rect(0, 0, 10, 10), 5, 2);
    const adj: Building = { ...mkPlan(rect(20, 0, 30, 10), 5, 2), type: "인접건물" };
    const p = mkProject(6, 5, 2);
    p.buildings = [plan, adj];
    const r = runNorthSetbackCheck(p);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].buildingId).toBe(plan.id);
  });
});
