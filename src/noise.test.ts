import { describe, expect, it } from "vitest";
import { maekawa, runNoise } from "./noise";
import { mkBuilding, mkProject, rect } from "./testutil";

describe("도로소음 간이 예측", () => {
  const road = { layer: "ROAD_CL" as const, closed: false, points: [{ x: -2000, y: -8 }, { x: 2000, y: -8 }] };

  it("긴 직선도로에서 7.5m 떨어진 1층 외벽 ≈ L0", async () => {
    // 동 남측 벽 y=0 → 수음점 y=0.5, 도로 y=-8 → 거리 8.5m
    const b = mkBuilding("A", "계획주동", rect(-10, 0, 10, 10), 1);
    const p = mkProject([b]);
    p.siteOverlays = [road];
    const r = await runNoise(p, { l0: 68, limit: 65, maxDist: 2000, step: 5 }, () => {});
    const south = r.points.filter((q) => q.normal.z > 0.9); // 남향 벽
    const avg = south.reduce((s, q) => s + q.db, 0) / south.length;
    expect(avg).toBeGreaterThan(66);
    expect(avg).toBeLessThan(68.5);
    // 북향 벽은 도로가 벽 뒤라 계산 안 됨(0) — 측정점 자체는 존재
    expect(r.points.some((q) => q.normal.z < -0.9)).toBe(true);
  });

  it("앞에 높은 건물이 막으면 5dB 이상 줄고, 고층으로 갈수록 장벽 효과가 줄어든다", async () => {
    const back = mkBuilding("뒤", "계획주동", rect(-10, 30, 10, 40), 20);
    const wall = mkBuilding("앞", "인접건물", rect(-60, 10, 60, 20), 5); // 15m
    const open = mkProject([mkBuilding("뒤", "계획주동", rect(-10, 30, 10, 40), 20)]);
    open.siteOverlays = [road];
    const shielded = mkProject([back, wall]);
    shielded.siteOverlays = [road];
    const o = await runNoise(open, { l0: 68, limit: 65, maxDist: 2000, step: 5 }, () => {});
    const s = await runNoise(shielded, { l0: 68, limit: 65, maxDist: 2000, step: 5 }, () => {});
    const at = (r: typeof o, f: number) => {
      const pts = r.points.filter((q) => q.normal.z > 0.9 && q.floor === f);
      return pts.reduce((a, q) => a + q.db, 0) / pts.length;
    };
    expect(at(o, 1) - at(s, 1)).toBeGreaterThan(5);
    expect(at(o, 20) - at(s, 20)).toBeLessThan(at(o, 1) - at(s, 1));
  });

  it("Maekawa 감쇠 — 경로차 0이면 0, 커질수록 증가, 20dB 상한", () => {
    expect(maekawa(0)).toBe(0);
    expect(maekawa(0.5)).toBeGreaterThan(maekawa(0.1));
    expect(maekawa(100)).toBe(20);
  });
});
