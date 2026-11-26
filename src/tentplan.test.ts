import { describe, expect, it } from "vitest";
import { defaultTentOptions, depthsOf, edgeFloorsOf, planTent } from "./tentplan";
import { mkBuilding, mkProject, rect } from "./testutil";

/** 대지 200×60 안에 동서로 5동 (20×12), 가운데가 가장 깊다 */
function site() {
  const bs = [0, 1, 2, 3, 4].map((i) => mkBuilding(`P${i}`, "계획주동", rect(10 + i * 38, 24, 30 + i * 38, 36), 1, { name: `계획주동_A_${i + 1}` }));
  const p = mkProject(bs);
  p.siteOverlays = [{ layer: "SITE_BOUNDARY", closed: true, points: rect(0, 0, 200, 60) }];
  p.site.siteAreaM2 = 12000;
  return p;
}

describe("텐트형 층수 배분", () => {
  it("깊이 — 가운데 동이 1, 양 끝이 가장 얕다", () => {
    const p = site();
    const d = depthsOf(p, p.buildings);
    expect(d.get("P2")).toBeCloseTo(1, 6);
    expect(d.get("P0")!).toBeLessThan(d.get("P1")!);
    expect(d.get("P4")!).toBeLessThan(d.get("P3")!);
  });

  it("가장자리 층수 — 주변 건물 층수 × 배수, 없으면 최저층", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), minFloors: 5, edgeFactor: 1.5, assumedAdjFloors: 0 };
    expect(edgeFloorsOf(p, p.buildings[0], o)).toBe(5);
    p.buildings.push(mkBuilding("N", "인접건물", rect(-30, 20, -10, 40), 6));
    expect(edgeFloorsOf(p, p.buildings[0], o)).toBe(9);
    // 주변 최소 10층 가정 — 실제 6층보다 가정이 높으면 가정값
    expect(edgeFloorsOf(p, p.buildings[0], { ...o, edgeFactor: 1, assumedAdjFloors: 10 })).toBe(10);
    expect(edgeFloorsOf(p, p.buildings[1], { ...o, edgeFactor: 1, assumedAdjFloors: 10 })).toBe(10);
  });

  it("목표 용적률을 채우는 가장 낮은 텐트, 가운데가 가장 높고 바깥으로 낮아짐", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "far" as const, value: 100 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
    const legal = new Map(p.buildings.map((b) => [b.id, 40]));
    const r = planTent(p, legal, o);
    expect(r.meets).toBe(true);
    const f = (id: string) => r.rows.find((x) => x.id === id)!.floors;
    expect(f("P2")).toBeGreaterThan(f("P1"));
    expect(f("P1")).toBeGreaterThan(f("P0"));
    expect(f("P0")).toBeGreaterThanOrEqual(5);
    // 연면적 = 240㎡ × Σ층 → 용적률 100% = 12000㎡ = 50층분 (최저 5층 × 5동 = 25층보다 많아야 텐트가 선다)
    expect(r.farPct!).toBeGreaterThanOrEqual(100);
    expect(r.farPct!).toBeLessThan(110);
  });

  it("법규 최대 층수로 잘리고, 한도 안에서 못 채우면 미달과 부족분", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "far" as const, value: 400 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 30 };
    const legal = new Map(p.buildings.map((b) => [b.id, b.id === "P2" ? 12 : 30]));
    const r = planTent(p, legal, o);
    expect(r.rows.find((x) => x.id === "P2")!.floors).toBe(12);
    expect(r.rows.find((x) => x.id === "P2")!.capped).toBe(true);
    expect(r.meets).toBe(false);
    expect(r.gap).toBeLessThan(0);
  });

  it("세대수 목표 — 평형 구성 없는 동은 바닥면적 ÷ 세대당 면적", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "units" as const, value: 30 }, areaPerUnit: 110, minFloors: 3, maxFloors: 30 };
    const r = planTent(p, new Map(p.buildings.map((b) => [b.id, 30])), o);
    // 240㎡ → 층당 2세대
    expect(r.units).toBeGreaterThanOrEqual(30);
    expect(r.units % 2).toBe(0);
  });
});

describe("텐트 완화", () => {
  it("최고층 텐트로 모자라면 낮은 동을 끌어올려 채우고, 가운데가 가장 높은 순서는 유지", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "far" as const, value: 230 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 30 };
    // 가운데 동은 법규로 12층에 묶임 → 텐트만으로는 230%(115층분) 못 채움, 최대 4×30+12 = 132층분
    const legal = new Map(p.buildings.map((b) => [b.id, b.id === "P2" ? 12 : 30]));
    const r = planTent(p, legal, o);
    expect(r.relaxedLift).not.toBeNull();
    expect(r.meets).toBe(true);
    const f = (id: string) => r.rows.find((x) => x.id === id)!.floors;
    expect(f("P2")).toBe(12);
    expect(f("P1")).toBeGreaterThanOrEqual(f("P0"));
    expect(f("P0")).toBeGreaterThanOrEqual(r.relaxedLift! - 1);
  });

  it("텐트로 충분하면 완화하지 않는다", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "far" as const, value: 100 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
    expect(planTent(p, new Map(p.buildings.map((b) => [b.id, 40])), o).relaxedLift).toBeNull();
  });
});

describe("조감도 규칙 — 탑상형·날개·남저북고·높이 단계", async () => {
  const { massRoles, northnessOf, aspectOf } = await import("./tentplan");
  it("탑상형(크고 정방형) / 탑에 붙은 작은 동 = 날개 / 떨어진 작은 동 = 판상", () => {
    const tower = mkBuilding("T", "계획주동", rect(0, 0, 25, 25), 1);
    const wing = mkBuilding("W", "계획주동", rect(25, 5, 45, 17), 1); // 탑 동측에 붙음
    const slab = mkBuilding("S", "계획주동", rect(100, 0, 125, 11), 1);
    const roles = massRoles([tower, wing, slab], defaultTentOptions(10000));
    expect(roles.get("T")!.role).toBe("탑상");
    expect(roles.get("W")).toEqual({ role: "날개", tower: "T" });
    expect(roles.get("S")!.role).toBe("판상");
    expect(aspectOf(slab.footprint)).toBeCloseTo(25 / 11, 1);
  });

  it("남저북고 — 북쪽 동이 1, 남쪽 동이 0", () => {
    const p = mkProject([
      mkBuilding("S", "계획주동", rect(0, 0, 25, 25), 1),
      mkBuilding("N", "계획주동", rect(0, 100, 25, 125), 1),
    ]);
    const n = northnessOf(p, p.buildings);
    expect(n.get("S")).toBe(0);
    expect(n.get("N")).toBe(1);
  });

  it("탑은 높고 날개·판상은 낮으며, 층수는 5층 단위", () => {
    const tower = mkBuilding("T", "계획주동", rect(80, 20, 105, 45), 1);
    const wing = mkBuilding("W", "계획주동", rect(105, 25, 125, 37), 1);
    const slab = mkBuilding("S", "계획주동", rect(10, 20, 35, 31), 1);
    const p = mkProject([tower, wing, slab]);
    p.siteOverlays = [{ layer: "SITE_BOUNDARY", closed: true, points: rect(0, 0, 200, 70) }];
    p.site.siteAreaM2 = 14000;
    const o = { ...defaultTentOptions(14000), target: { kind: "far" as const, value: 100 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
    const r = planTent(p, new Map(p.buildings.map((b) => [b.id, 40])), o);
    const f = (id: string) => r.rows.find((x) => x.id === id)!.floors;
    expect(f("T")).toBeGreaterThan(f("W"));
    expect(f("T")).toBeGreaterThan(f("S"));
    for (const x of r.rows) expect(x.floors % 5).toBe(0);
  });
});

describe("우선순위 법규 맞춤", async () => {
  const { planTentLegal } = await import("./tentplan");
  const { failingRule } = await import("./maxfloors");
  it("마주 보는 탑(북)과 판상(남) — 탑이 인동거리 여유를 먼저 차지하고, 결과는 법규 적합", async () => {
    // 남측 판상 (창 북향), 북측 탑 (창 남향), 30m 간격
    const slab = mkBuilding("S", "계획주동", rect(0, 0, 30, 11), 1, { windowSegments: [[{ x: 25, y: 11 }, { x: 5, y: 11 }]] });
    const tower = mkBuilding("T", "계획주동", rect(0, 41, 25, 66), 1, { windowSegments: [[{ x: 5, y: 41 }, { x: 20, y: 41 }]] });
    const p = mkProject([slab, tower]);
    p.siteOverlays = [{ layer: "SITE_BOUNDARY", closed: true, points: rect(-40, -40, 70, 110) }];
    p.site.siteAreaM2 = 16500;
    const o = { ...defaultTentOptions(16500), target: { kind: "far" as const, value: 80 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40, tierStep: 0, skipSetback: false, spacingTolPct: 0 };
    const r = await planTentLegal(p, o);
    const f = (id: string) => r.rows.find((x) => x.id === id)!.floors;
    expect(r.rows.find((x) => x.id === "T")!.role).toBe("탑상");
    expect(f("T")).toBeGreaterThan(f("S"));
    p.buildings.find((b) => b.id === "T")!.floors = f("T");
    p.buildings.find((b) => b.id === "S")!.floors = f("S");
    expect(failingRule(p, p.buildings[0])).toBeNull();
    expect(failingRule(p, p.buildings[1])).toBeNull();
  });
});

describe("법규 여유", async () => {
  const { planTentLegal } = await import("./tentplan");
  it("인동거리 여유 %를 주면 더 높일 수 있다", async () => {
    const slab = mkBuilding("S", "계획주동", rect(0, 0, 30, 11), 1, { windowSegments: [[{ x: 25, y: 11 }, { x: 5, y: 11 }]] });
    // 탑을 판상 동쪽(동서 배치)에 둬서 나목이 아닌 가목이 걸리게
    const tower = mkBuilding("T", "계획주동", rect(50, -5, 75, 20), 1, { windowSegments: [[{ x: 50, y: 0 }, { x: 50, y: 15 }]] });
    const p = mkProject([slab, tower]);
    p.siteOverlays = [{ layer: "SITE_BOUNDARY", closed: true, points: rect(-40, -40, 120, 60) }];
    p.site.siteAreaM2 = 16000;
    p.analysis.setbackRules.spacingNaEnabled = false; // 정동~정서는 나목 대상 — 가목 여유만 확인
    const base = { ...defaultTentOptions(16000), target: { kind: "far" as const, value: 500 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40, tierStep: 0, skipSetback: true };
    const strict = await planTentLegal(p, { ...base, spacingTolPct: 0 });
    const loose = await planTentLegal(p, { ...base, spacingTolPct: 20 });
    const f = (r: typeof strict) => r.rows.find((x) => x.id === "T")!.floors;
    expect(f(loose)).toBeGreaterThan(f(strict));
  });
});

describe("법규 무시 배분", async () => {
  const { planTentRuleOnly } = await import("./tentplan");
  it("법규와 무관하게 목표 용적률을 채우는 가장 낮은 텐트", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), northWeight: 0, tierStep: 0, slabRatio: 1, assumedAdjFloors: 0, target: { kind: "far" as const, value: 150 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
    const r = planTentRuleOnly(p, o);
    expect(r.meets).toBe(true);
    expect(r.farPct!).toBeGreaterThanOrEqual(150);
    expect(r.rows.every((x) => !x.capped)).toBe(true);
    const f = (id: string) => r.rows.find((x) => x.id === id)!.floors;
    expect(f("P2")).toBeGreaterThan(f("P0"));
  });
});
