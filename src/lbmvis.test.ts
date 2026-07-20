import { describe, expect, it } from "vitest";
import { lbmColor } from "./lbmvis";

/** M10 히트맵 컬러맵 — 구간점·포화·단조성 확인 (캔버스 생성은 브라우저 전용이라 제외) */
describe("lbmColor — 속도비 컬러맵", () => {
  it("구간점 색이 정확: 0=파랑, 0.5=청록, 1.2=노랑, 2.0=빨강", () => {
    expect(lbmColor(0)).toEqual([0x1e, 0x3a, 0x8a]);
    expect(lbmColor(0.5)).toEqual([0x06, 0xb6, 0xd4]);
    expect(lbmColor(1.2)).toEqual([0xea, 0xb3, 0x08]);
    expect(lbmColor(2.0)).toEqual([0xef, 0x44, 0x44]);
  });

  it("범위 밖은 포화: 음수→파랑, 2 초과→빨강", () => {
    expect(lbmColor(-1)).toEqual([0x1e, 0x3a, 0x8a]);
    expect(lbmColor(3.5)).toEqual([0xef, 0x44, 0x44]);
  });

  it("구간 내부는 선형 보간 — 중간값이 양 끝 사이에 있다", () => {
    const [r, g, b] = lbmColor(0.25); // 파랑↔청록 중간
    expect(r).toBeGreaterThanOrEqual(0x06);
    expect(r).toBeLessThanOrEqual(0x1e);
    expect(g).toBeGreaterThan(0x3a);
    expect(g).toBeLessThan(0xb6);
    expect(b).toBeGreaterThan(0x8a);
    expect(b).toBeLessThan(0xd4);
  });
});
