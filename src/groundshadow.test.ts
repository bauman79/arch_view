import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { contourSegments, makeGrid, pointShaded, shadowCasters, shadowMask, sunPlan } from "./groundshadow";
import { runShadowPlan } from "./shadowplan";
import { mkBuilding, mkProject, rect } from "./testutil";

describe("groundshadow — 평지 해석 그림자", () => {
  // 10×10 동, 30m(10층×3m). 태양: 정남, 고도 45° → 그림자 길이 30m (북쪽)
  const tower = mkBuilding("T", "계획주동", rect(0, 0, 10, 10), 10);
  const casters = shadowCasters([tower]);
  const sunDir = new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2); // three z+ = 남
  const sp = sunPlan(sunDir)!;

  it("태양 방향 변환 — 정남 태양은 도면 -y 쪽, tan 45° = 1", () => {
    expect(sp.dx).toBeCloseTo(0, 6);
    expect(sp.dy).toBeCloseTo(-1, 6);
    expect(sp.tan).toBeCloseTo(1, 6);
  });

  it("북쪽 20m는 그늘, 40m는 볕, 동쪽 옆은 볕", () => {
    expect(pointShaded(5, 10 + 20, casters, sp)).toBe(true);
    expect(pointShaded(5, 10 + 40, casters, sp)).toBe(false);
    expect(pointShaded(25, 20, casters, sp)).toBe(false);
  });

  it("필로티(1층 개방) 아래 남쪽 가장자리는 볕, 필로티가 없으면 그늘", () => {
    const pil = shadowCasters([mkBuilding("P", "계획주동", rect(0, 0, 10, 10), 10, { pilotiFloors: 1 })]);
    expect(pointShaded(5, 1, pil, sp)).toBe(false);
    expect(pointShaded(5, 1, casters, sp)).toBe(true);
    expect(pointShaded(5, 15, pil, sp)).toBe(true);
  });

  it("격자 마스크 = 점 판정, 그림자 면적 ≈ 10 × (10+30)", () => {
    const g = makeGrid(-20, -20, 40, 60, 1);
    const m = shadowMask(g, casters, sunDir);
    let n = 0;
    for (let k = 0; k < m.length; k++) n += m[k];
    expect(n).toBeGreaterThan(380);
    expect(n).toBeLessThan(420);
  });

  it("마칭 스퀘어 — 원형 필드의 등치선 길이 ≈ 둘레", () => {
    const g = makeGrid(-50, -50, 50, 50, 1);
    const f = new Float32Array(g.nx * g.ny);
    for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) {
      const x = -50 + ix + 0.5, y = -50 + iy + 0.5;
      f[iy * g.nx + ix] = 30 - Math.hypot(x, y);
    }
    const segs = contourSegments(g, f, 10); // 반지름 20 원
    const len = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0);
    expect(len).toBeGreaterThan(2 * Math.PI * 20 * 0.97);
    expect(len).toBeLessThan(2 * Math.PI * 20 * 1.03);
  });
});

describe("일영도", () => {
  it("동지 9~15시 — 북쪽 가까운 인접건물은 4시간 이상 그늘 범위에 걸린다", async () => {
    const tower = mkBuilding("T", "계획주동", rect(0, 0, 20, 10), 25); // 75m
    const near = mkBuilding("N", "인접건물", rect(5, 25, 15, 35), 2);
    const far = mkBuilding("F", "인접건물", rect(200, 25, 210, 35), 2);
    const r = await runShadowPlan(
      mkProject([tower, near, far]),
      { startMin: 540, endMin: 900, stepMin: 10, cell: 2, levels: [2, 3, 4], target: "plan" },
      () => {},
    );
    expect(r.hourly.length).toBe(7); // 9~15시
    expect(r.iso.every((s) => s.segs.length > 0)).toBe(true);
    expect(r.outsideArea[0].area).toBeGreaterThan(r.outsideArea[2].area);
    expect(r.affected.map((a) => a.name)).toEqual(["N"]);
  });
});
