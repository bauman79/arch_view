import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { runPrivacy, privacyLevel } from "./privacy";
import { computeElevation, facing, unionLength } from "./skyline";
import { runSkyView, skyDirections } from "./skyview";
import { mkBuilding, mkProject, rect } from "./testutil";
import type { Point2 } from "./types";

type Seg = [Point2, Point2];

describe("천공률·개방감", () => {
  it("하늘 방향은 창 앞 반구 위쪽, 가중치 양수", () => {
    const n = new THREE.Vector3(0, 0, 1);
    for (const s of skyDirections(n)) {
      expect(s.dir.y).toBeGreaterThan(0);
      expect(s.dir.dot(n)).toBeGreaterThan(-1e-6);
      expect(s.w).toBeGreaterThanOrEqual(0);
    }
  });

  it("트인 창은 천공률·개방감 ≈ 100%, 앞 동에 가린 저층은 낮다", async () => {
    const win: Seg[] = [[{ x: 5, y: 0 }, { x: 15, y: 0 }]];
    const a = mkBuilding("A", "계획주동", rect(0, 0, 20, 10), 10, { windowSegments: win });
    const open = await runSkyView(mkProject([a]), 1.2, () => {});
    expect(Math.min(...open.points.map((p) => p.svf))).toBeGreaterThan(0.99);
    expect(Math.min(...open.points.map((p) => p.openness))).toBeGreaterThan(0.99);
    const front = mkBuilding("F", "인접건물", rect(-30, -25, 50, -15), 15);
    const shut = await runSkyView(mkProject([a, front]), 1.2, () => {});
    const low = shut.points.find((p) => p.floor === 1)!;
    const high = shut.points.find((p) => p.floor === 10)!;
    expect(low.svf).toBeLessThan(0.6);
    expect(high.svf).toBeGreaterThan(low.svf);
    expect(low.frontDist).toBeCloseTo(15, 0);
  });
});

describe("세대 간 시선 간섭", () => {
  // 마주 보는 두 동: A 북벽(y=10) 창, B 남벽(y=10+d) 창
  const pair = (d: number, between = false) => {
    const a = mkBuilding("A", "계획주동", rect(0, 0, 20, 10), 10, { windowSegments: [[{ x: 15, y: 10 }, { x: 5, y: 10 }]] });
    const b = mkBuilding("B", "계획주동", rect(0, 10 + d, 20, 20 + d), 8, { windowSegments: [[{ x: 5, y: 10 + d }, { x: 15, y: 10 + d }]] });
    const bs = [a, b];
    if (between) bs.push(mkBuilding("W", "인접건물", rect(-5, 10 + d / 2 - 1, 25, 10 + d / 2 + 1), 2));
    return runPrivacy(mkProject(bs), 20, false);
  };

  it("8m 마주 봄 → 심각, 겹치는 층(8개층)만큼 세대 쌍", () => {
    const r = pair(8);
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0].level).toBe("severe");
    expect(r.unitPairs.severe).toBe(8);
  });

  it("거리 초과·사이 건물이 있으면 없음", () => {
    expect(pair(25).pairs.length).toBe(0);
    expect(pair(12, true).pairs.length).toBe(0);
    expect(privacyLevel(12)).toBe("caution");
  });
});

describe("스카이라인·입면", () => {
  it("구간 합집합", () => {
    expect(unionLength([[0, 10], [5, 15], [20, 25]])).toBe(20);
  });

  it("남측 입면 — 동서로 늘어선 두 동이 대지 폭의 절반을 가림", () => {
    const p = mkProject([
      mkBuilding("A", "계획주동", rect(0, 0, 25, 10), 20),
      mkBuilding("B", "계획주동", rect(50, 0, 75, 10), 10),
    ]);
    p.siteOverlays = [{ layer: "SITE_BOUNDARY", closed: true, points: rect(0, -10, 100, 30) }];
    const r = computeElevation(p, "south");
    expect(facing("south", 0)).toEqual({ x: -0, y: 1 });
    expect(r.coverRatio).toBeCloseTo(0.5, 5);
    expect(r.maxH).toBe(60);
    expect(r.minH).toBe(30);
    // 동측 입면은 두 동이 겹쳐 보여 폭 10m / 대지 40m
    const e = computeElevation(p, "east");
    expect(e.coverRatio).toBeCloseTo(10 / 40, 5);
  });
});
