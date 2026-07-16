import { describe, expect, it } from "vitest";
import { signedArea } from "./geom2d";
import {
  coverageStats,
  createTemplateBuilding,
  distributeUnits,
  footprintAreaM2,
  siteUnitTotals,
  SLAB_DEPTH,
  templateFootprint,
  totalUnits,
  UNIT_WIDTH,
  unitBreakdown,
} from "./massing";
import type { Building } from "./types";

/**
 * M6/M6.8 세대수 검증 (plan.md 7장 M6 검증):
 * M6.8부터 unitMix는 평형별 **층당 세대수**(countPerFloor)를 직접 저장한다.
 * 총 세대수 = countPerFloor × 주거층수 × 분절 수로 매번 새로 계산되므로,
 * 층수·필로티·분절이 바뀌면 총 세대수도 자동으로 재계산된다(버그 수정 검증 포함).
 * distributeUnits는 신규 건물 생성 시 초기 층당세대수를 50/30/20으로 시드하는 데만 쓰인다.
 */

// ---------- 세대수 산출 ----------

describe("세대수 (평형별 층당세대수 입력 기반, M6.8)", () => {
  it("totalUnits/unitBreakdown = countPerFloor × 주거층수", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    b.floors = 10;
    b.pilotiFloors = 1; // 주거층수 9
    b.unitMix = [
      { unitType: "59㎡", countPerFloor: 2 },
      { unitType: "84㎡", countPerFloor: 1 },
    ];
    expect(unitBreakdown(b)).toEqual([
      { unitType: "59㎡", count: 18 },
      { unitType: "84㎡", count: 9 },
    ]);
    expect(totalUnits(b)).toBe(27);
  });

  it("버그 수정: 층수를 바꾸면 총 세대수가 자동으로 재계산된다", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    b.pilotiFloors = 0;
    b.unitMix = [{ unitType: "84㎡", countPerFloor: 2 }];
    b.floors = 10;
    expect(totalUnits(b)).toBe(20); // 10층 × 2세대/층
    b.floors = 15;
    expect(totalUnits(b)).toBe(30); // 층수 변경 즉시 반영 — 재입력 불필요
    b.pilotiFloors = 5;
    expect(totalUnits(b)).toBe(20); // 필로티 변경도 즉시 반영 (10주거층×2)
  });

  it("분절형은 분절 수만큼 곱해진다", () => {
    const b = createTemplateBuilding("segment", 4, 2, 1);
    b.floors = 10;
    b.pilotiFloors = 1; // 주거층수 9
    b.unitMix = [{ unitType: "84㎡", countPerFloor: 2 }];
    expect(totalUnits(b)).toBe(9 * 2 * 2); // 9층 × 2세대/층 × 2분절 = 36
  });

  it("평형 추가/삭제로 unitMix를 자유롭게 편집할 수 있다", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    b.floors = 5;
    b.pilotiFloors = 0;
    b.unitMix = [];
    expect(totalUnits(b)).toBe(0);
    b.unitMix.push({ unitType: "39㎡", countPerFloor: 1 });
    b.unitMix.push({ unitType: "59㎡", countPerFloor: 2 });
    expect(totalUnits(b)).toBe(5 + 10); // 5층×1 + 5층×2
    b.unitMix.splice(0, 1);
    expect(totalUnits(b)).toBe(10);
  });

  it("음수 countPerFloor는 0으로 클램프된다", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    b.unitMix = [{ unitType: "x", countPerFloor: -5 }];
    expect(totalUnits(b)).toBe(0);
    expect(unitBreakdown(b)[0].count).toBe(0);
  });

  it("신규 건물 생성 시 층당세대(unitsPerFloor)가 50/30/20으로 층당 배분된다", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1); // 층당세대 4 → 2/1/1로 시드
    expect(b.unitMix).toEqual([
      { unitType: "59㎡", countPerFloor: 2 },
      { unitType: "84㎡", countPerFloor: 1 },
      { unitType: "101㎡", countPerFloor: 1 },
    ]);
    // 기본 15층·필로티0 → 15층 × (2/1/1) = 30/15/15 = 60세대
    expect(totalUnits(b)).toBe(60);
    expect(unitBreakdown(b)).toEqual([
      { unitType: "59㎡", count: 30 },
      { unitType: "84㎡", count: 15 },
      { unitType: "101㎡", count: 15 },
    ]);
  });

  it("구성비 50/30/20 × 36세대 → 18/11/7 (최대잉여법, 합계 보존)", () => {
    const counts = distributeUnits(36, [
      { unitType: "59㎡", ratio: 50 },
      { unitType: "84㎡", ratio: 30 },
      { unitType: "101㎡", ratio: 20 },
    ]);
    expect(counts).toEqual([
      { unitType: "59㎡", count: 18 },
      { unitType: "84㎡", count: 11 },
      { unitType: "101㎡", count: 7 },
    ]);
    expect(counts.reduce((s, c) => s + c.count, 0)).toBe(36);
  });

  it("구성비 합이 100이 아니어도 비율로 정규화된다", () => {
    const counts = distributeUnits(10, [
      { unitType: "A", ratio: 1 },
      { unitType: "B", ratio: 1 },
    ]);
    expect(counts.map((c) => c.count)).toEqual([5, 5]);
  });

  it("배분 합계는 항상 총 세대수와 같다 (무작위 케이스)", () => {
    for (let total = 1; total <= 60; total++) {
      const counts = distributeUnits(total, [
        { unitType: "a", ratio: 37 },
        { unitType: "b", ratio: 41 },
        { unitType: "c", ratio: 22 },
      ]);
      expect(counts.reduce((s, c) => s + c.count, 0)).toBe(total);
    }
  });

  it("사이트 합계 = 동별 unitMix 합", () => {
    const a = createTemplateBuilding("slab", 4, 1, 1);
    a.floors = 9;
    a.pilotiFloors = 0;
    a.unitMix = [{ unitType: "84㎡", countPerFloor: 4 }]; // 9층×4 = 36
    const b = createTemplateBuilding("tower", 6, 1, 1); // 기본 15층·필로티0
    b.unitMix = [{ unitType: "101㎡", countPerFloor: 8 }]; // 15층×8 = 120
    const t = siteUnitTotals([a, b]);
    expect(t.buildingCount).toBe(2);
    expect(t.total).toBe(156);
    expect(t.byType.reduce((s, u) => s + u.count, 0)).toBe(156);
  });

  it("인접건물(unitsPerFloor=0)은 합계에서 제외", () => {
    const adj: Building = {
      ...createTemplateBuilding("slab", 4, 1, 1),
      type: "인접건물",
      unitsPerFloor: 0,
      unitMix: [],
    };
    expect(siteUnitTotals([adj]).total).toBe(0);
    expect(unitBreakdown(adj)).toEqual([]);
  });
});

// ---------- 템플릿 footprint ----------

describe("타입 템플릿 footprint", () => {
  it("판상형: 층당 4세대 → 44×12m 장방형, CCW", () => {
    const fp = templateFootprint("slab", 4, 1);
    expect(fp).toHaveLength(4);
    expect(Math.abs(signedArea(fp))).toBeCloseTo(4 * UNIT_WIDTH * SLAB_DEPTH, 3);
    expect(signedArea(fp)).toBeGreaterThan(0); // CCW
  });

  it("탑상형: 정방형, 면적 ≈ 세대 × 135㎡", () => {
    const fp = templateFootprint("tower", 6, 1);
    expect(fp).toHaveLength(4);
    expect(Math.abs(signedArea(fp))).toBeCloseTo(6 * 135, 1);
  });

  it("분절형 2분절: 폴리곤 6점(miter), CCW, 면적 ≈ 2 × 판상형", () => {
    const fp = templateFootprint("segment", 4, 2);
    expect(fp).toHaveLength(6);
    expect(signedArea(fp)).toBeGreaterThan(0);
    const single = 4 * UNIT_WIDTH * SLAB_DEPTH;
    // 꺾임부 miter 때문에 정확히 2배는 아님 — ±10% 이내
    expect(Math.abs(signedArea(fp))).toBeGreaterThan(2 * single * 0.9);
    expect(Math.abs(signedArea(fp))).toBeLessThan(2 * single * 1.1);
  });

  it("footprint 중심은 원점", () => {
    for (const fp of [
      templateFootprint("slab", 4, 1),
      templateFootprint("segment", 4, 3),
    ]) {
      let cx = 0;
      let cy = 0;
      for (const p of fp) {
        cx += p.x;
        cy += p.y;
      }
      expect(cx / fp.length).toBeCloseTo(0, 6);
      expect(cy / fp.length).toBeCloseTo(0, 6);
    }
  });
});

// ---------- 건폐율·용적률 ----------

describe("건폐율·용적률", () => {
  it("판상형 1동(528㎡)·10층·필로티1 / 대지 5000㎡", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    b.floors = 10;
    b.pilotiFloors = 1;
    expect(footprintAreaM2(b)).toBeCloseTo(528, 3);
    const s = coverageStats([b], 5000);
    expect(s.coverageM2).toBeCloseTo(528, 3);
    expect(s.grossM2).toBeCloseTo(528 * 9, 3); // 필로티 제외 9층
    expect(s.bcrPct).toBeCloseTo((528 / 5000) * 100, 3);
    expect(s.farPct).toBeCloseTo(((528 * 9) / 5000) * 100, 3);
  });

  it("대지면적 미입력이면 null", () => {
    const b = createTemplateBuilding("slab", 4, 1, 1);
    const s = coverageStats([b], 0);
    expect(s.bcrPct).toBeNull();
    expect(s.farPct).toBeNull();
  });

  it("인접건물은 건폐율에서 제외", () => {
    const adj: Building = {
      ...createTemplateBuilding("slab", 4, 1, 1),
      type: "인접건물",
    };
    expect(coverageStats([adj], 1000).coverageM2).toBe(0);
  });
});
