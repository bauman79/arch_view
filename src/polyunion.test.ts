import { describe, expect, it } from "vitest";
import { signedArea } from "./geom2d";
import { unionAdjacentPolygons } from "./polyunion";
import type { Point2 } from "./types";

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const area = (p: Point2[]): number => Math.abs(signedArea(p));

/** 폴리곤을 하나의 축정렬 직사각형으로 볼 수 있는지 (정점 수 무관, 바운딩 = 면적) */
function isRect(p: Point2[], w: number, h: number): boolean {
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  return (
    Math.abs(Math.max(...xs) - Math.min(...xs) - w) < 1e-6 &&
    Math.abs(Math.max(...ys) - Math.min(...ys) - h) < 1e-6 &&
    Math.abs(area(p) - w * h) < 1e-6
  );
}

describe("떨어진 폴리곤은 합치지 않는다 (기존 '여러 동 배치' 규약 보존)", () => {
  it("10m 떨어진 같은 형상 2개 → 2동 그대로", () => {
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), rect(20, 0, 30, 10)]);
    expect(r.polygons).toHaveLength(2);
    expect(r.failures).toEqual([]);
    expect(r.sources).toEqual([[0], [1]]);
  });

  it("아주 가깝지만(0.5m) 닿지 않으면 여전히 별개", () => {
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), rect(10.5, 0, 20, 10)]);
    expect(r.polygons).toHaveLength(2);
  });

  it("한 점에서만 만나면 합치지 않는다 (대각 접촉)", () => {
    // 모서리 하나만 공유 — 엣지 공유가 아니므로 별개로 남는다
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), rect(10, 10, 20, 20)]);
    expect(r.polygons).toHaveLength(2);
  });

  it("폴리곤이 하나뿐이면 그대로", () => {
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10)]);
    expect(r.polygons).toHaveLength(1);
    expect(r.polygons[0]).toEqual(rect(0, 0, 10, 10));
  });
});

describe("벽을 맞댄 폴리곤은 합친다", () => {
  it("정확히 벽을 공유한 사각형 2개 → 직사각형 하나", () => {
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), rect(10, 0, 20, 10)]);
    expect(r.polygons).toHaveLength(1);
    expect(r.failures).toEqual([]);
    expect(r.sources[0].sort()).toEqual([0, 1]);
    expect(isRect(r.polygons[0], 20, 10)).toBe(true);
  });

  it("유니트 3개가 일렬로 맞닿으면 한 동", () => {
    const r = unionAdjacentPolygons([
      rect(0, 0, 10, 10),
      rect(10, 0, 20, 10),
      rect(20, 0, 30, 10),
    ]);
    expect(r.polygons).toHaveLength(1);
    expect(isRect(r.polygons[0], 30, 10)).toBe(true);
  });

  it("유니트 + 코어가 L자로 붙어도 면적이 보존된다", () => {
    const r = unionAdjacentPolygons([
      rect(0, 0, 10, 10), // 유니트
      rect(10, 0, 20, 10), // 유니트
      rect(10, 10, 20, 20), // 코어 (위쪽에 붙음)
    ]);
    expect(r.polygons).toHaveLength(1);
    expect(area(r.polygons[0])).toBeCloseTo(300, 6);
  });

  it("맞닿은 덩어리와 떨어진 동이 섞여 있으면 각각 처리한다", () => {
    const r = unionAdjacentPolygons([
      rect(0, 0, 10, 10), // ┐ 맞닿음
      rect(10, 0, 20, 10), // ┘
      rect(50, 0, 60, 10), // 별개 동
    ]);
    expect(r.polygons).toHaveLength(2);
    expect(isRect(r.polygons[0], 20, 10)).toBe(true);
    expect(isRect(r.polygons[1], 10, 10)).toBe(true);
  });

  it("입력 방향(CW/CCW)이 섞여도 같은 결과", () => {
    const cw = [...rect(10, 0, 20, 10)].reverse();
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), cw]);
    expect(r.polygons).toHaveLength(1);
    expect(isRect(r.polygons[0], 20, 10)).toBe(true);
  });

  it("결과는 반시계(CCW) 방향으로 나온다", () => {
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), rect(10, 0, 20, 10)]);
    expect(signedArea(r.polygons[0])).toBeGreaterThan(0);
  });
});

describe("허용오차", () => {
  it("1mm 어긋난 정점은 같은 점으로 보고 합친다", () => {
    const a = rect(0, 0, 10, 10);
    const b: Point2[] = [
      { x: 10.001, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10.001, y: 10.001 },
    ];
    const r = unionAdjacentPolygons([a, b]);
    expect(r.polygons).toHaveLength(1);
  });

  it("허용오차를 넘어 어긋나면 합치지 않는다", () => {
    const b = rect(10.05, 0, 20, 10); // 5cm 어긋남
    const r = unionAdjacentPolygons([rect(0, 0, 10, 10), b]);
    expect(r.polygons).toHaveLength(2);
  });
});

describe("합칠 수 없는 배치는 원본을 지키고 알린다", () => {
  it("가운데가 뚫린 링(중정)은 합치지 않고 사유를 남긴다", () => {
    // 도넛 형태로 둘러싸면 외곽 링과 구멍 링 2개가 나와 하나로 확정되지 않는다
    const ring = [
      rect(0, 0, 10, 10),
      rect(10, 0, 20, 10),
      rect(20, 0, 30, 10),
      rect(20, 10, 30, 20),
      rect(20, 20, 30, 30),
      rect(10, 20, 20, 30),
      rect(0, 20, 10, 30),
      rect(0, 10, 10, 20),
    ];
    const r = unionAdjacentPolygons(ring);
    expect(r.polygons).toHaveLength(8); // 원본 유지
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("합치지 않고");
  });

  it("실패해도 형상은 하나도 잃지 않는다", () => {
    const ring = [
      rect(0, 0, 10, 10),
      rect(10, 0, 20, 10),
      rect(20, 0, 30, 10),
      rect(20, 10, 30, 20),
      rect(20, 20, 30, 30),
      rect(10, 20, 20, 30),
      rect(0, 20, 10, 30),
      rect(0, 10, 10, 20),
    ];
    const r = unionAdjacentPolygons(ring);
    const total = r.polygons.reduce((s, p) => s + area(p), 0);
    expect(total).toBeCloseTo(800, 6);
  });
});
