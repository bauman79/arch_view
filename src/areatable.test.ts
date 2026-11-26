import { describe, expect, it } from "vitest";
import { parseAreaTableSheet } from "./areatable";
import { residentialFloorAreaM2, supplyAreaOf, DEFAULT_AREA_ROWS } from "./massing";
import { mkBuilding, rect } from "./testutil";

// 독산동 건축개요(2026-11-26) 분양면적표 축약
const sheet: unknown[][] = [
  ["계획대지", 79257.8, 23975.48],
  ["용적률산정연면적", null, 218219.6, 66011.43],
  ["■ 아파트 분양면적표"],
  ["TYPE", "세대수", "비율", "전용면적", "주거공용면적", null, null, "공급면적", "기타공용면적"],
  [null, null, null, null, "코어공용", "벽체공용", "소계", null, "부대복리시설", "기계,전기실", "소계"],
  [39, 402, 0.18, 39.96, 13.14, 4.51, 17.65, 57.61, 1.4630, 4.27, 5.73],
  [49, 0, 0, 49.96, 14.14, 5.51, 19.65, 69.61, "#DIV/0!"],
  [59, 746, 0.34, 59.98, 16.82, 5.83, 22.65, 82.63, 2.2013],
  [84, 851, 0.39, 84.97, 21.97, 7.28, 29.25, 114.22, 3.1072],
  [109, 189, 0.09, 109.97, 22.67, 7.98, 30.65, 140.62, 4.0251],
  ["합계", 2188, 1, 153902.8, 40811.1, 13865.7, 54676.8, 208579.6, 5640],
];

describe("면적표 엑셀 읽기", () => {
  it("평형별 전용·주거공용, 세대당 부대복리, 근생", () => {
    const r = parseAreaTableSheet(sheet)!;
    expect(r.rows.map((x) => x.type)).toEqual([39, 49, 59, 84, 109]);
    expect(r.rows[3]).toEqual({ type: 84, exclusiveM2: 84.97, commonM2: 29.25 });
    expect(r.units).toBe(2188);
    expect(r.amenityPerUnit).toBeCloseTo(5640 / 2188, 1);
    expect(r.retailM2).toBeGreaterThan(3990);
    expect(r.retailM2).toBeLessThan(4010);
    expect(r.siteAreaM2).toBe(79257.8);
  });
});

describe("공급면적 산정", () => {
  it("같은 평형은 표 값, 없는 평형(79)은 주거공용 보간", () => {
    expect(supplyAreaOf("84㎡", DEFAULT_AREA_ROWS)).toBeCloseTo(114.22, 2);
    const a79 = supplyAreaOf("79㎡", DEFAULT_AREA_ROWS)!;
    expect(a79).toBeGreaterThan(79 + 26.95);
    expect(a79).toBeLessThan(79 + 29.25);
  });
  it("면적표를 켜면 층 바닥면적 = Σ 세대 × 공급면적", () => {
    const b = mkBuilding("P", "계획주동", rect(0, 0, 30, 20), 10, {
      unitMix: [{ unitType: "84㎡", countPerFloor: 4 }],
      unitsPerFloor: 4,
    });
    expect(residentialFloorAreaM2(b)).toBeCloseTo(600);
    expect(residentialFloorAreaM2(b, { enabled: true, rows: DEFAULT_AREA_ROWS })).toBeCloseTo(4 * 114.22, 2);
  });
});
