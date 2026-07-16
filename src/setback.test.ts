import { describe, expect, it } from "vitest";
import { runDaylightCheck } from "./daylight";
import { polygonPolygonClosest, rayPolygonDistance } from "./geom2d";
import { runSpacingCheck } from "./spacing";
import {
  defaultProject,
  type Building,
  type BuildingType,
  type Point2,
  type Project,
} from "./types";

/**
 * M3 수계산 대조표 (plan.md 7장 검증 방법).
 * 채광사선: H/D ≤ 배율(4.0), 인동거리: 이격 ≥ 높이 × 배율(남북 0.8 / 동서 0.5).
 *
 * | 케이스 | 손계산 기대값 |
 * |---|---|
 * | 채광 H=20, D=6            | H/D = 3.333 ≤ 4.0 → 적합 |
 * | 채광 H=20, D=4            | H/D = 5.0 > 4.0 → 위반 |
 * | 채광 H=20, D=5 (경계)     | H/D = 4.0 → 적합 |
 * | 인동 남북 H=30, 이격 24   | 기준 30×0.8=24 → 적합(경계) |
 * | 인동 남북 H=30, 이격 23   | 24 초과 요구 → 위반 |
 * | 인동 동서 H=30, 이격 15   | 기준 30×0.5=15 → 적합(경계) |
 * | 인동 동서 H=30, 이격 14   | → 위반 |
 * | 인동 H 혼합 30/60 남북    | 기준 = max(30,60)×0.8 = 48 |
 * | 회전 90° 채광창           | 벽면 법선이 함께 회전 — 서향 벽이 남향으로 |
 */

let seq = 0;
function mkBuilding(
  type: BuildingType,
  footprint: Point2[],
  floors: number,
  floorHeight: number,
): Building {
  return {
    id: `t-${++seq}`,
    name: `${type} ${seq}`,
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
    analysisTarget: type === "인접건물",
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  // CCW
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
  return p;
}

// ---------- geom2d ----------

describe("geom2d", () => {
  it("반직선-폴리곤 거리", () => {
    const poly = rect(0, -18, 10, -6);
    // (5,0)에서 남쪽(0,-1)으로 → y=-6 에지까지 6m
    expect(rayPolygonDistance({ x: 5, y: 0 }, { x: 0, y: -1 }, poly)).toBeCloseTo(6);
    // 북쪽으로는 교차 없음
    expect(rayPolygonDistance({ x: 5, y: 0 }, { x: 0, y: 1 }, poly)).toBeNull();
  });

  it("폴리곤 간 최단거리 — 평행 이격 사각형", () => {
    const a = rect(0, 0, 20, 10);
    const b = rect(0, 34, 20, 44);
    const c = polygonPolygonClosest(a, b);
    expect(c.distance).toBeCloseTo(24);
  });

  it("폴리곤 간 최단거리 — 대각 배치는 꼭짓점 간 거리", () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(13, 14, 20, 20);
    // (10,10)-(13,14) → √(9+16)=5
    const c = polygonPolygonClosest(a, b);
    expect(c.distance).toBeCloseTo(5);
  });

  it("겹치면 거리 0", () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(5, 5, 15, 15);
    expect(polygonPolygonClosest(a, b).distance).toBe(0);
  });
});

// ---------- 채광사선 (제86조 제3항 제1호) ----------
// 검토 대상은 계획주동(PLAN_WIN 창면)뿐 — 창면에서 직각방향 최근접 기준선까지 거리 D에 대해
// H ≤ 2×D (법정 기본 2배, 근린상업·준주거는 4배 설정). 도로·공원 중심선도 제3호에 따라
// 인접대지경계선으로 보아 같은 배율 적용.

describe("채광사선 (H/D ≤ 2.0 법정 기본, ADJ_BOUNDARY 기준)", () => {
  // 계획주동 10×10, 높이 H=20(10층×2m). 북측 벽(에지2)에 창 표시.
  // ADJ_BOUNDARY를 북측 벽(y=10)에서 D만큼 떨어진 y=10+D에 둔다.
  function daylightCase(D: number) {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 2); // H=20
    plan.windowSegments = [[plan.footprint[2], plan.footprint[3]]]; // 북측 벽
    const p = mkProject([plan]);
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
    return { plan, project: p };
  }

  it("PLAN_WIN이 있는 벽만 검토된다 (10m 벽 → 3개)", () => {
    const { project } = daylightCase(6);
    const r = runDaylightCheck(project);
    expect(r.checks).toHaveLength(3);
    for (const c of r.checks) {
      expect(c.normal.x).toBeCloseTo(0);
      expect(c.normal.y).toBeCloseTo(1);
    }
  });

  it("H=20, D=12 → H/D=1.67 ≤ 2.0 적합", () => {
    const { project } = daylightCase(12);
    const r = runDaylightCheck(project);
    expect(r.violations).toBe(0);
    expect(r.checks[0].distance).toBeCloseTo(12, 3);
    expect(r.checks[0].ratio).toBeCloseTo(20 / 12, 3);
    expect(r.checks[0].boundaryType).toBe("ADJ_BOUNDARY");
  });

  it("H=20, D=6 → H/D=3.33 > 2.0 위반", () => {
    const { project } = daylightCase(6);
    const r = runDaylightCheck(project);
    expect(r.violations).toBe(3);
    expect(r.checks[0].ratio).toBeCloseTo(20 / 6, 3);
  });

  it("경계값 H=20, D=10 → H/D=2.0 적합", () => {
    const { project } = daylightCase(10);
    const r = runDaylightCheck(project);
    expect(r.violations).toBe(0);
  });

  it("근린상업·준주거 설정(4배)이면 D=6도 적합", () => {
    const { project } = daylightCase(6); // H/D = 3.33
    project.analysis.setbackRules.daylightRatio = 4.0;
    const r = runDaylightCheck(project);
    expect(r.violations).toBe(0);
  });

  it("주동 이동(offset.dy)이 D에 반영된다", () => {
    const { plan, project } = daylightCase(12);
    plan.offset.dy = 4; // 북쪽 4m 접근 → D=8 → H/D=2.5 위반
    const r = runDaylightCheck(project);
    expect(r.checks[0].distance).toBeCloseTo(8, 3);
    expect(r.violations).toBe(3);
  });

  it("법선 방향에 기준선이 없으면 적합(거리 null)", () => {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 2);
    plan.windowSegments = [[plan.footprint[2], plan.footprint[3]]];
    const r = runDaylightCheck(mkProject([plan])); // siteOverlays 없음
    expect(r.checks).toHaveLength(3);
    expect(r.violations).toBe(0);
    for (const c of r.checks) expect(c.distance).toBeNull();
  });

  it("ROAD_CL 기준선(도로 중심선=인접대지경계선 간주, 제3호)에도 같은 배율이 적용된다", () => {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 1); // H=10
    plan.windowSegments = [[plan.footprint[2], plan.footprint[3]]];
    const p = mkProject([plan]);
    p.siteOverlays = [
      {
        layer: "ROAD_CL",
        points: [
          { x: -5, y: 16 },
          { x: 15, y: 16 },
        ],
        closed: false,
      },
    ];
    // D=6, H=10 → H/D=1.67 ≤ 2.0 적합
    const r = runDaylightCheck(p);
    expect(r.checks[0].boundaryType).toBe("ROAD_CL");
    expect(r.checks[0].appliedRatio).toBeCloseTo(2.0);
    expect(r.violations).toBe(0);

    // H를 올리면(20m) H/D=3.33 > 2.0 위반
    plan.floorHeight = 2;
    const r2 = runDaylightCheck(p);
    expect(r2.violations).toBe(3);
  });

  it("여러 기준선 중 가장 가까운 것을 기준으로 삼는다", () => {
    const { project } = daylightCase(10); // ADJ_BOUNDARY @ D=10
    // 더 가까운 ROAD_CL(D=6)을 추가 — 레이어 종류와 무관하게 최근접 채택
    project.siteOverlays.push({
      layer: "ROAD_CL",
      points: [
        { x: -5, y: 16 },
        { x: 15, y: 16 },
      ],
      closed: false,
    });
    const r = runDaylightCheck(project);
    expect(r.checks[0].distance).toBeCloseTo(6, 3);
    expect(r.checks[0].boundaryType).toBe("ROAD_CL");
  });

  it("PLAN_WIN이 없는 주동은 skippedBuildings에 포함되고 검토에서 제외된다", () => {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 2); // windowSegments 기본 []
    const r = runDaylightCheck(mkProject([plan]));
    expect(r.checks).toHaveLength(0);
    expect(r.skippedBuildings).toContain(plan.name);
  });

  it("창 없는 다른 벽은 검토에서 제외된다(에지 매칭)", () => {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 2);
    plan.windowSegments = [[plan.footprint[1], plan.footprint[2]]]; // 동측 벽만 창
    const p = mkProject([plan]);
    p.siteOverlays = [
      { layer: "ADJ_BOUNDARY", points: [{ x: 20, y: -5 }, { x: 20, y: 15 }], closed: false },
    ];
    const r = runDaylightCheck(p);
    expect(r.checks).toHaveLength(3);
    for (const c of r.checks) expect(c.normal.x).toBeCloseTo(1); // 동향
  });

  it("주동 회전 시 창 법선이 함께 회전한다", () => {
    const plan = mkBuilding("계획주동", rect(0, 0, 10, 10), 10, 2);
    plan.windowSegments = [[plan.footprint[2], plan.footprint[3]]]; // 로컬 북측 벽
    const project = mkProject([plan]);
    plan.offset.rotation = 90; // 로컬 북측 벽이 서쪽을 향하게 됨
    project.siteOverlays = [
      {
        layer: "ADJ_BOUNDARY",
        points: [
          { x: -6, y: -5 },
          { x: -6, y: 15 },
        ],
        closed: false,
      },
    ];
    const r = runDaylightCheck(project);
    expect(r.checks).toHaveLength(3);
    for (const c of r.checks) {
      expect(c.normal.x).toBeCloseTo(-1);
      expect(c.normal.y).toBeCloseTo(0);
    }
    expect(r.checks[0].distance).toBeCloseTo(6, 3);
  });
});

// ---------- 인동거리 (건축법 시행령 제86조 제3항 제2호) ----------
// 벽면 직각방향으로 실제 마주보는 쌍만 검토 — 기본값 채광×0.5 / 창없음↔측벽 8m / 측벽↔측벽 4m.

describe("인동거리 — 마주보는 벽면 판정 (직각방향 겹침)", () => {
  // 두 동 모두 20×10, 높이 30m (10층 × 3m). windowSegments 비어있음 → 채광벽 취급(0.5×30=15m)
  function twoTowers(gapNS: number | null, gapEW: number | null) {
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const b = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    if (gapNS !== null) b.offset.dy = 10 + gapNS;
    if (gapEW !== null) b.offset.dx = 20 + gapEW;
    return mkProject([a, b]);
  }

  it("정면으로 마주보는 남북 배치: 기준 15m(0.5×30) — 15m 적합 / 14m 위반", () => {
    const pass = runSpacingCheck(twoTowers(15, null));
    expect(pass.checks).toHaveLength(1);
    expect(pass.checks[0].rule).toBe("채광");
    expect(pass.checks[0].distance).toBeCloseTo(15);
    expect(pass.checks[0].required).toBeCloseTo(15);
    expect(pass.checks[0].overlapLen).toBeCloseTo(20); // 20m 벽 전체가 마주봄
    expect(pass.checks[0].pass).toBe(true);

    const fail = runSpacingCheck(twoTowers(14, null));
    expect(fail.checks[0].pass).toBe(false);
    expect(fail.violations).toBe(1);
  });

  it("★ 대각선 배치(직각방향 확장이 안 만남)는 검토 대상이 아니다", () => {
    // A: x∈[0,20], y∈[0,10] / B: x∈[25,45], y∈[15,25]
    // x구간·y구간 모두 겹치지 않음 — 어느 벽면에서 직각으로 확장해도 상대를 못 만남
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const b = mkBuilding("계획주동", rect(25, 15, 45, 25), 10, 3);
    const r = runSpacingCheck(mkProject([a, b]));
    expect(r.checks).toHaveLength(0); // 예전엔 대각선 최단거리로 잘못 검토하던 케이스
  });

  it("부분적으로 겹치면 겹치는 구간만큼 마주봄으로 인정", () => {
    // B를 동쪽으로 15m 밀면 x 겹침 = [15,20] → 5m — 남북 이격 4m는 기준 15m 미달
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const b = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    b.offset.dx = 15;
    b.offset.dy = 14; // 이격 4m
    const r = runSpacingCheck(mkProject([a, b]));
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].overlapLen).toBeCloseTo(5);
    expect(r.checks[0].distance).toBeCloseTo(4);
    expect(r.checks[0].pass).toBe(false);
  });

  it("높이가 다르면 높은 동 기준 — 30m/60m 남북 → 기준 30m(0.5×60)", () => {
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3); // 30m
    const b = mkBuilding("계획주동", rect(0, 39, 20, 49), 20, 3); // 60m, 이격 29m
    const r = runSpacingCheck(mkProject([a, b]));
    expect(r.checks[0].height).toBeCloseTo(60);
    expect(r.checks[0].required).toBeCloseTo(30);
    expect(r.checks[0].distance).toBeCloseTo(29);
    expect(r.checks[0].pass).toBe(false);
  });

  it("동 회전 90° 시 회전된 footprint 기준으로 마주봄·거리 계산", () => {
    // B(20×10)를 동쪽 이격 5m에 두고 90° 회전하면 x폭이 10으로 줄어 이격 10m로 늘어난다
    const p = twoTowers(null, 5);
    const b = p.buildings[1];
    b.offset.rotation = 90;
    const r = runSpacingCheck(p);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].distance).toBeCloseTo(10);
  });

  it("계획주동 1동이면 검토 쌍 없음, 인접건물은 제외", () => {
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const adj = mkBuilding("인접건물", rect(0, 30, 20, 40), 5, 3);
    const r = runSpacingCheck(mkProject([a, adj]));
    expect(r.checks).toHaveLength(0);
  });

  it("평면상 겹치면 이격 0으로 즉시 위반", () => {
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const b = mkBuilding("계획주동", rect(10, 5, 30, 15), 10, 3);
    const r = runSpacingCheck(mkProject([a, b]));
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].distance).toBe(0);
    expect(r.checks[0].pass).toBe(false);
  });

  it("배율 변경(서울시 0.8배)이 기준거리에 반영된다", () => {
    const p = twoTowers(20, null);
    p.analysis.setbackRules.spacingRatioWindow = 0.8; // 서울시 조례 → 기준 24m
    const r = runSpacingCheck(p);
    expect(r.checks[0].required).toBeCloseTo(24);
    expect(r.checks[0].pass).toBe(false); // 20m < 24m
  });
});

// ---------- 창면(PLAN_WIN) 반영 — 인동거리 규칙 분류 ----------

describe("인동거리 — 벽면 종류별 기준 (가·라·마목)", () => {
  // 판상형 비례(20×10): 남·북벽 20m(장변), 동·서벽 10m(=최장변 절반 → 측벽)
  function facingTowers(gapNS: number) {
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3); // 30m, 북측=에지2
    const b = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3); // 남측=에지0
    b.offset.dy = 10 + gapNS;
    return { a, b, project: mkProject([a, b]) };
  }

  it("가목: 마주보는 벽 중 하나라도 채광창이 있으면 0.5×H", () => {
    const { a, b, project } = facingTowers(14);
    a.windowSegments = [[a.footprint[2], a.footprint[3]]]; // a 북측(마주보는 벽)에 창
    b.windowSegments = [[b.footprint[2], b.footprint[3]]]; // b는 반대쪽에만 창 — 마주보는 남측엔 없음
    const r = runSpacingCheck(project);
    expect(r.checks[0].rule).toBe("채광");
    expect(r.checks[0].required).toBeCloseTo(15); // 30 × 0.5
    expect(r.checks[0].pass).toBe(false); // 14 < 15
  });

  it("라목: 마주보는 두 벽(장변) 모두 창이 없으면 8m", () => {
    const { a, b, project } = facingTowers(9);
    // 마주보지 않는 반대쪽 벽에만 창 표시 — 마주보는 면(a 북측/b 남측)은 창 없음
    a.windowSegments = [[a.footprint[0], a.footprint[1]]]; // a 남측
    b.windowSegments = [[b.footprint[2], b.footprint[3]]]; // b 북측
    const r = runSpacingCheck(project);
    expect(r.checks[0].rule).toBe("창없음");
    expect(r.checks[0].required).toBeCloseTo(8);
    expect(r.checks[0].distance).toBeCloseTo(9);
    expect(r.checks[0].pass).toBe(true); // 9m ≥ 8m

    const tight = facingTowers(7);
    tight.a.windowSegments = [[tight.a.footprint[0], tight.a.footprint[1]]];
    tight.b.windowSegments = [[tight.b.footprint[2], tight.b.footprint[3]]];
    expect(runSpacingCheck(tight.project).checks[0].pass).toBe(false); // 7m < 8m
  });

  it("마목: 측벽(단변)끼리 마주보면 4m", () => {
    // 동서로 나란히 — a 동측벽(에지1, 10m)과 b 서측벽(에지3, 10m)이 마주봄
    const a = mkBuilding("계획주동", rect(0, 0, 20, 10), 10, 3);
    const b = mkBuilding("계획주동", rect(25, 0, 45, 10), 10, 3); // 이격 5m
    // 양쪽 다 장변에만 창 — 마주보는 측벽엔 창 없음
    a.windowSegments = [[a.footprint[0], a.footprint[1]]];
    b.windowSegments = [[b.footprint[0], b.footprint[1]]];
    const r = runSpacingCheck(mkProject([a, b]));
    expect(r.checks[0].rule).toBe("측벽");
    expect(r.checks[0].required).toBeCloseTo(4);
    expect(r.checks[0].distance).toBeCloseTo(5);
    expect(r.checks[0].pass).toBe(true); // 5m ≥ 4m

    const tight = mkBuilding("계획주동", rect(23, 0, 43, 10), 10, 3); // 이격 3m
    tight.windowSegments = [[tight.footprint[0], tight.footprint[1]]];
    const r2 = runSpacingCheck(mkProject([a, tight]));
    expect(r2.checks[0].rule).toBe("측벽");
    expect(r2.checks[0].pass).toBe(false); // 3m < 4m
  });

  it("PLAN_WIN 데이터가 없으면(빈 배열) 하위호환으로 채광벽(가목) 간주", () => {
    const { project } = facingTowers(14); // 기준 15m 미달
    const r = runSpacingCheck(project);
    expect(r.checks[0].rule).toBe("채광");
    expect(r.checks[0].pass).toBe(false);
  });

  it("창없음·측벽 최소거리도 설정으로 조정 가능", () => {
    const { a, b, project } = facingTowers(9);
    a.windowSegments = [[a.footprint[0], a.footprint[1]]];
    b.windowSegments = [[b.footprint[2], b.footprint[3]]];
    project.analysis.setbackRules.spacingNoWindowM = 10; // 조례 강화
    const r = runSpacingCheck(project);
    expect(r.checks[0].required).toBeCloseTo(10);
    expect(r.checks[0].pass).toBe(false); // 9m < 10m
  });
});
