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
    const o = { ...defaultTentOptions(12000), assumedAdjFloors: 0, target: { kind: "far" as const, value: 100 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
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
    const o = { ...defaultTentOptions(12000), assumedAdjFloors: 0, target: { kind: "far" as const, value: 400 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 30 };
    const legal = new Map(p.buildings.map((b) => [b.id, b.id === "P2" ? 12 : 30]));
    const r = planTent(p, legal, o);
    expect(r.rows.find((x) => x.id === "P2")!.floors).toBe(12);
    expect(r.rows.find((x) => x.id === "P2")!.capped).toBe(true);
    expect(r.meets).toBe(false);
    expect(r.gap).toBeLessThan(0);
  });

  it("세대수 목표 — 평형 구성 없는 동은 바닥면적 ÷ 세대당 면적", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), assumedAdjFloors: 0, target: { kind: "units" as const, value: 30 }, areaPerUnit: 110, minFloors: 3, maxFloors: 30 };
    const r = planTent(p, new Map(p.buildings.map((b) => [b.id, 30])), o);
    // 240㎡ → 층당 2세대
    expect(r.units).toBeGreaterThanOrEqual(30);
    expect(r.units % 2).toBe(0);
  });
});

describe("텐트 완화", () => {
  it("최고층 텐트로 모자라면 낮은 동을 끌어올려 채우고, 가운데가 가장 높은 순서는 유지", () => {
    const p = site();
    const o = { ...defaultTentOptions(12000), assumedAdjFloors: 0, target: { kind: "far" as const, value: 230 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 30 };
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
    const o = { ...defaultTentOptions(12000), assumedAdjFloors: 0, target: { kind: "far" as const, value: 100 }, retailM2: 0, amenityPerUnit: 0, minFloors: 5, maxFloors: 40 };
    expect(planTent(p, new Map(p.buildings.map((b) => [b.id, 40])), o).relaxedLift).toBeNull();
  });
});
