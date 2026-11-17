import { describe, expect, it } from "vitest";
import { drapePolygon, makeSurface } from "./drape";

describe("지형에 정확히 얹기", () => {
  // 경사면 z = 0.5·x 를 이루는 두 삼각형 (0~20 × 0~20)
  const s = makeSurface(Float64Array.from([
    0, 0, 0, 20, 0, 10, 20, 20, 10,
    0, 0, 0, 20, 20, 10, 0, 20, 0,
  ]));

  it("잘린 조각의 면적 합 = 다각형 면적, 모든 점이 지형 평면 + lift 위", () => {
    const pos = drapePolygon(s, [{ x: 5, y: 2 }, { x: 15, y: 2 }, { x: 15, y: 18 }, { x: 5, y: 18 }], 0.1);
    let area = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], az = -pos[i + 2], bx = pos[i + 3], bz = -pos[i + 5], cx = pos[i + 6], cz = -pos[i + 8];
      area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    expect(area).toBeCloseTo(160, 6);
    for (let i = 0; i < pos.length; i += 3) expect(pos[i + 1]).toBeCloseTo(0.5 * pos[i] + 0.1, 6);
  });

  it("오목 다각형(ㄱ자)도 면적 보존, 지형 밖은 버림", () => {
    const L = [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 18, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 18 }, { x: 2, y: 18 }];
    const pos = drapePolygon(s, L, 0);
    let area = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], az = -pos[i + 2], bx = pos[i + 3], bz = -pos[i + 5], cx = pos[i + 6], cz = -pos[i + 8];
      area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    expect(area).toBeCloseTo(16 * 4 + 4 * 12, 6);
    expect(drapePolygon(s, [{ x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }], 0)).toHaveLength(0);
  });
});
