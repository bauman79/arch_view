import { describe, expect, it } from "vitest";
import { nearbyBuildings } from "./nearby";
import { mkBuilding, rect } from "./testutil";

describe("분석 반경", () => {
  const plan = mkBuilding("P", "계획주동", rect(0, 0, 20, 20), 10);
  const near = mkBuilding("N", "인접건물", rect(100, 0, 110, 10), 5);
  const far = mkBuilding("F", "인접건물", rect(500, 0, 510, 10), 5);
  const site = [{ layer: "SITE_BOUNDARY" as const, closed: true, points: rect(-10, -10, 30, 30) }];
  it("반경 안 주변 건물과 계획주동만", () => {
    expect(nearbyBuildings([plan, near, far], site, 100).map((b) => b.id)).toEqual(["P", "N"]);
  });
  it("0이면 전부", () => {
    expect(nearbyBuildings([plan, near, far], site, 0)).toHaveLength(3);
  });
});
