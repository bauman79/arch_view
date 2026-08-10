import { describe, expect, it } from "vitest";
import { isDrag, isTap, tapSlopPx } from "./pointer";

describe("tapSlopPx", () => {
  it("마우스는 4px, 터치·펜은 12px", () => {
    expect(tapSlopPx("mouse")).toBe(4);
    expect(tapSlopPx("touch")).toBe(12);
    expect(tapSlopPx("pen")).toBe(12);
  });

  it("알 수 없는 포인터 종류는 넉넉한 쪽(터치)으로 본다", () => {
    // 선택이 안 되는 것보다 배치가 안 밀리는 쪽이 안전하다
    expect(tapSlopPx("")).toBe(12);
  });
});

describe("isTap — 클릭/탭 판정", () => {
  const origin = { x: 100, y: 100 };

  it("제자리 클릭은 탭", () => {
    expect(isTap("mouse", origin, { x: 100, y: 100 })).toBe(true);
  });

  it("마우스 3px 이동은 탭, 5px는 드래그", () => {
    expect(isTap("mouse", origin, { x: 103, y: 100 })).toBe(true);
    expect(isTap("mouse", origin, { x: 105, y: 100 })).toBe(false);
  });

  it("손가락 흔들림(6~10px)은 터치에서 여전히 탭 — 태블릿 선택 실패 회귀 방지", () => {
    expect(isTap("touch", origin, { x: 106, y: 103 })).toBe(true);
    expect(isTap("touch", origin, { x: 100, y: 110 })).toBe(true);
  });

  it("같은 6px 이동이라도 마우스에서는 드래그로 본다", () => {
    expect(isTap("mouse", origin, { x: 106, y: 100 })).toBe(false);
  });

  it("터치 12px 이상은 드래그", () => {
    expect(isTap("touch", origin, { x: 112, y: 100 })).toBe(false);
  });

  it("대각선 거리는 유클리드로 잰다 (축별 비교 아님)", () => {
    // dx=9, dy=9 → 거리 12.7 > 12 이므로 드래그
    expect(isTap("touch", origin, { x: 109, y: 109 })).toBe(false);
    // dx=8, dy=8 → 거리 11.3 < 12 이므로 탭
    expect(isTap("touch", origin, { x: 108, y: 108 })).toBe(true);
  });

  it("시작점을 모르면 탭이 아니다", () => {
    expect(isTap("touch", null, origin)).toBe(false);
  });
});

describe("isDrag", () => {
  it("isTap의 여집합", () => {
    const down = { x: 0, y: 0 };
    for (const cur of [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 50, y: 50 }]) {
      expect(isDrag("touch", down, cur)).toBe(!isTap("touch", down, cur));
    }
  });
});
