import { describe, expect, it } from "vitest";
import { runShadeWalk, sidewalkPoints } from "./shadewalk";
import { classify, seasonPrevailing, summerScore, winterScore } from "./thermal";
import { mkBuilding, mkProject, rect } from "./testutil";
import type { WindRoseData } from "./wind";

describe("가로 그늘보행권", () => {
  it("ROAD_AREA 가장자리 안쪽 1.5m에 보도 점", () => {
    const { points, source } = sidewalkPoints(
      [{ layer: "ROAD_AREA", closed: true, points: rect(0, 0, 30, 10) }],
      () => true,
      6,
    );
    expect(source).toBe("ROAD_AREA");
    expect(points.length).toBeGreaterThan(20);
    for (const w of points) {
      const inX = w.p.x >= 1.5 - 1e-6 && w.p.x <= 28.5 + 1e-6;
      const inY = w.p.y >= 1.5 - 1e-6 && w.p.y <= 8.5 + 1e-6;
      expect(inX && inY).toBe(true);
    }
  });

  it("남쪽 도로에 면한 고층 동 — 8월 오후 북측 보도가 사업 후 더 그늘", async () => {
    // 동 남측에 동서 도로, 동 북측에도 동서 도로 — 북측 도로가 동 그림자에 든다
    const tower = mkBuilding("T", "계획주동", rect(0, 0, 40, 15), 20);
    const p = mkProject([tower]);
    p.siteOverlays = [
      { layer: "ROAD_CL", closed: false, points: [{ x: -20, y: 25 }, { x: 60, y: 25 }] },
    ];
    const r = await runShadeWalk(
      p,
      { date: "2026-08-01", startMin: 660, endMin: 960, radius: 100, threshold: 0.5, halfWidth: 5 },
      () => {},
    );
    expect(r.source).toBe("ROAD_CL");
    expect(r.ratioBefore).toBe(0);
    expect(r.ratioAfter).toBeGreaterThan(0.1);
  });
});

describe("외부공간 열쾌적성 점수", () => {
  it("여름 그늘+통풍, 겨울 볕+바람막이면 사계절 쾌적", () => {
    expect(classify(summerScore(1, 1), winterScore(1, 0))).toBe("both");
    expect(classify(summerScore(0, 0.2), winterScore(0, 1.5))).toBe("poor");
    expect(classify(summerScore(0.9, 0.5), winterScore(0.1, 1.2))).toBe("summer");
    expect(classify(summerScore(0, 0.3), winterScore(0.9, 0.2))).toBe("winter");
  });

  it("계절 주풍향 — 여러 달 도수 합의 최빈 방위", () => {
    const st = (hot: number) => ({
      hours: 100, calmHours: 0, meanSpeedMs: 2, prevailingDirDeg: hot * 22.5,
      sectorHours: Array.from({ length: 16 }, (_, i) => (i === hot ? 50 : 1)),
    });
    const rose: WindRoseData = {
      annual: st(0),
      monthly: Array.from({ length: 12 }, (_, i) => st(i >= 5 && i <= 7 ? 9 : 14)),
    };
    expect(seasonPrevailing(rose, [6, 7, 8])).toBe(9 * 22.5);
    expect(seasonPrevailing(rose, [12, 1, 2])).toBe(14 * 22.5);
  });
});

describe("그늘보행권 — 차양", () => {
  it("보도 위 차양이 그늘 보행 비율을 올린다 (사업 전·후는 그대로)", async () => {
    const tower = mkBuilding("T", "계획주동", rect(500, 500, 510, 510), 2); // 멀리 떨어진 계획동
    const p = mkProject([tower]);
    p.siteOverlays = [{ layer: "ROAD_CL", closed: false, points: [{ x: 400, y: 400 }, { x: 600, y: 400 }] }];
    const base = { date: "2026-08-01", startMin: 660, endMin: 960, radius: 200, threshold: 0.5, halfWidth: 5 };
    const r0 = await runShadeWalk(p, base, () => {});
    // 북측 보도(y=405) 위 40m 차양, 폭 4m, 높이 3.5m
    const r1 = await runShadeWalk(
      p,
      { ...base, canopies: [{ id: "c", a: { x: 480, y: 405 }, b: { x: 520, y: 405 }, width: 4, height: 3.5 }] },
      () => {},
    );
    expect(r0.ratioCanopy).toBe(r0.ratioAfter);
    expect(r1.canopyCount).toBe(1);
    expect(r1.ratioAfter).toBe(r0.ratioAfter);
    expect(r1.ratioCanopy).toBeGreaterThan(r1.ratioAfter);
    // 차양 바로 밑 보도 점은 대부분 그늘
    const under = r1.points.filter((w) => Math.abs(w.p.y - 405) < 0.5 && w.p.x > 485 && w.p.x < 515);
    expect(under.length).toBeGreaterThan(3);
    for (const w of under) expect(w.canopy).toBeGreaterThan(0.5);
  });
});
