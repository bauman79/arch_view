import { describe, expect, it } from "vitest";
import { edgeHasWindow, segmentLiesOnEdge } from "./windows";
import type { Point2 } from "./types";

/**
 * 창선↔벽면 매칭 규칙 — 벽 전체를 덮지 않는 **부분 창선**도 그 벽의 창으로 인정한다.
 * (과거: 창선 양 끝점이 벽 끝점과 일치해야만 매칭 → 벽 일부에만 그린 창이 조용히 버려져
 *  채광사선·인동거리가 "창 없는 벽"으로 잘못 판정됐음.)
 * 판정 단위는 여전히 "벽면 1개" — 부분 창선이어도 그 벽 전체가 창 있는 벽이 된다.
 */

const a: Point2 = { x: 0, y: 0 };
const b: Point2 = { x: 20, y: 0 };

describe("segmentLiesOnEdge — 벽 위 창선 판정", () => {
  it("벽 전체를 덮는 창선은 매칭 (기존 동작 유지)", () => {
    expect(segmentLiesOnEdge(a, b, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(true);
  });

  it("벽 일부만 덮는 창선도 매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: 4, y: 0 }, { x: 9, y: 0 })).toBe(true);
  });

  it("벽 끝단에 붙은 짧은 창선도 매칭 (sample_site_test5 계획주동_A_1-5 케이스)", () => {
    expect(segmentLiesOnEdge(a, b, { x: 0, y: 0 }, { x: 4.6, y: 0 })).toBe(true);
    expect(segmentLiesOnEdge(a, b, { x: 15.4, y: 0 }, { x: 20, y: 0 })).toBe(true);
  });

  it("끝점 순서가 반대여도 매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: 9, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });

  it("허용오차(0.1m) 이내로 벽에서 떨어진 창선은 매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: 4, y: 0.05 }, { x: 9, y: 0.05 })).toBe(true);
  });

  it("허용오차를 넘게 떨어진 창선은 미매칭 — 평행한 반대편 벽 오인 방지", () => {
    expect(segmentLiesOnEdge(a, b, { x: 4, y: 0.5 }, { x: 9, y: 0.5 })).toBe(false);
    expect(segmentLiesOnEdge(a, b, { x: 4, y: 12 }, { x: 9, y: 12 })).toBe(false);
  });

  it("벽 연장선 위지만 벽 구간 밖이면 미매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: 25, y: 0 }, { x: 30, y: 0 })).toBe(false);
    expect(segmentLiesOnEdge(a, b, { x: -8, y: 0 }, { x: -3, y: 0 })).toBe(false);
  });

  it("모서리만 스치는(겹침 길이 ≈ 0) 창선은 미매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: -5, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });

  it("벽에 수직인 창선은 미매칭", () => {
    expect(segmentLiesOnEdge(a, b, { x: 10, y: 0 }, { x: 10, y: 5 })).toBe(false);
  });

  it("길이 0인 벽은 미매칭 (0으로 나누기 방지)", () => {
    expect(segmentLiesOnEdge(a, a, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false);
  });
});

describe("edgeHasWindow — 벽 단위 창 유무", () => {
  it("부분 창선 하나만 있어도 그 벽은 창 있는 벽", () => {
    expect(edgeHasWindow(a, b, [[{ x: 4, y: 0 }, { x: 9, y: 0 }]])).toBe(true);
  });

  it("다른 벽의 창선만 있으면 창 없는 벽", () => {
    expect(edgeHasWindow(a, b, [[{ x: 4, y: 12 }, { x: 9, y: 12 }]])).toBe(false);
  });

  it("창선이 없으면 창 없는 벽", () => {
    expect(edgeHasWindow(a, b, [])).toBe(false);
  });
});
