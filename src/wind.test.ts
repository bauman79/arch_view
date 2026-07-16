import { describe, expect, it } from "vitest";
import {
  computeWindField,
  computeWindRose,
  flowDirection,
  sampleWind,
  traceStreamlines,
  windDirLabel,
} from "./wind";
import { defaultProject, type Building, type Point2 } from "./types";

/**
 * M8 바람길 검증.
 * - computeWindRose: 합성 EPW(풍향 col20·풍속 col21)로 주풍향·평균풍속·결측/정온
 *   처리를 손계산 대조.
 * - computeWindField: 경계 조건 — 건물 내부 속도 0, 원방(far field)은 균일 흐름 복원.
 */

// ---------- 합성 EPW ----------

interface WindRow {
  month: number;
  dir: number;
  speed: number;
}

/** 최소 EPW 텍스트 — 헤더 8행 + 22컬럼 데이터 행 (col20=풍향, col21=풍속) */
function mkEpw(rows: WindRow[]): string {
  const header = [
    "LOCATION,Test,KR,,,471120,37.5,127.0,9.0,10.0",
    ...Array.from({ length: 7 }, (_, i) => `HEADER${i + 2}`),
  ];
  const data = rows.map((r) => {
    const f = new Array(24).fill("0");
    f[0] = "2026";
    f[1] = String(r.month);
    f[2] = "1";
    f[3] = "1";
    f[20] = String(r.dir);
    f[21] = String(r.speed);
    return f.join(",");
  });
  return [...header, ...data].join("\n");
}

describe("computeWindRose — 손계산 대조", () => {
  it("단일 풍향: 주풍향·평균풍속이 그대로 나온다", () => {
    const rose = computeWindRose(mkEpw([
      { month: 1, dir: 180, speed: 4 },
      { month: 1, dir: 180, speed: 4 },
      { month: 7, dir: 180, speed: 4 },
    ]));
    expect(rose.annual.hours).toBe(3);
    expect(rose.annual.prevailingDirDeg).toBe(180);
    expect(rose.annual.meanSpeedMs).toBeCloseTo(4, 6);
    expect(rose.monthly[0].hours).toBe(2); // 1월
    expect(rose.monthly[6].hours).toBe(1); // 7월
    expect(rose.monthly[6].prevailingDirDeg).toBe(180);
    expect(windDirLabel(180)).toBe("남");
  });

  it("혼합 풍향: 최빈 섹터가 주풍향, 평균은 전체 가중", () => {
    const rows: WindRow[] = [
      ...Array.from({ length: 30 }, () => ({ month: 1, dir: 90, speed: 2 })),
      ...Array.from({ length: 10 }, () => ({ month: 1, dir: 270, speed: 6 })),
    ];
    const rose = computeWindRose(mkEpw(rows));
    expect(rose.annual.prevailingDirDeg).toBe(90); // 동풍이 최빈
    expect(rose.annual.meanSpeedMs).toBeCloseTo((30 * 2 + 10 * 6) / 40, 6);
    expect(rose.annual.sectorHours[4]).toBe(30); // 동 = index 4
    expect(rose.annual.sectorHours[12]).toBe(10); // 서 = index 12
  });

  it("결측(999)은 제외, 정온(<0.5m/s)은 시간에는 넣되 방향 도수에서 뺀다", () => {
    const rose = computeWindRose(mkEpw([
      { month: 1, dir: 999, speed: 3 }, // 풍향 결측 — 통째로 제외
      { month: 1, dir: 0, speed: 999 }, // 풍속 결측 — 통째로 제외
      { month: 1, dir: 0, speed: 0 }, // 정온
      { month: 1, dir: 45, speed: 2 },
    ]));
    expect(rose.annual.hours).toBe(2);
    expect(rose.annual.calmHours).toBe(1);
    expect(rose.annual.meanSpeedMs).toBeCloseTo(1, 6); // (0+2)/2
    expect(rose.annual.prevailingDirDeg).toBe(45); // 북동 섹터만 도수 1
  });
});

// ---------- 속도장 ----------

function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function mkBuilding(id: string, footprint: Point2[]): Building {
  return {
    id,
    name: id,
    type: "계획주동",
    massType: "custom",
    footprint,
    floors: 10,
    floorHeight: 3,
    pilotiFloors: 0,
    unitsPerFloor: 0,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: true,
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

describe("computeWindField — 경계 조건", () => {
  it("건물 footprint 내부 격자점은 blocked·속도 0", () => {
    const site = defaultProject().site;
    const b = mkBuilding("b1", rect(-10, -10, 10, 10));
    const field = computeWindField([b], site, 0, 2);
    // 건물 중심(0,0)의 격자 인덱스
    const ix = Math.round((0 - field.originX) / field.gridM);
    const iy = Math.round((0 - field.originY) / field.gridM);
    const idx = iy * field.nx + ix;
    expect(field.blocked[idx]).toBe(1);
    expect(field.u[idx]).toBe(0);
    expect(field.v[idx]).toBe(0);
  });

  it("원방(far field)은 균일 흐름 복원 — 북풍(0°)은 남향(-y) 흐름", () => {
    const site = defaultProject().site;
    const b = mkBuilding("b1", rect(-10, -10, 10, 10));
    const field = computeWindField([b], site, 0, 2);
    // 흐름 방향: 북풍 = 남쪽으로 진행
    expect(field.flowDir.x).toBeCloseTo(0, 6);
    expect(field.flowDir.y).toBeCloseTo(-1, 6);
    // 건물에서 충분히 먼 상류 모서리 부근 — 속도비 ≈ 1, 방향 ≈ 흐름
    const vel = sampleWind(field, field.bounds.minX + 2, field.bounds.maxY - 2)!;
    const speed = Math.hypot(vel.x, vel.y);
    expect(speed / field.windSpeedMs).toBeGreaterThan(0.85);
    expect(speed / field.windSpeedMs).toBeLessThan(1.3);
    const dot = (vel.x * field.flowDir.x + vel.y * field.flowDir.y) / speed;
    expect(dot).toBeGreaterThan(0.95);
    // 후류 — 건물 배면(남쪽 하류)은 감속(바람그림자)
    const wake = sampleWind(field, 0, -13)!;
    expect(Math.hypot(wake.x, wake.y)).toBeLessThan(0.5 * field.windSpeedMs);
    expect(field.shadowAreaM2).toBeGreaterThan(0);
  });
});

describe("traceStreamlines", () => {
  it("시드에서 흐름 방향으로 진행하고 건물 내부에는 들어가지 않는다", () => {
    const site = defaultProject().site;
    const b = mkBuilding("b1", rect(-10, -10, 10, 10));
    const field = computeWindField([b], site, 0, 2);
    const lines = traceStreamlines(field, 20);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line.points.length).toBeGreaterThanOrEqual(2);
      // 북풍 → y 감소 방향 진행
      expect(line.points[line.points.length - 1].y).toBeLessThan(line.points[0].y);
      // 내부 차단 판정은 격자(2m) 최근접 셀 기준 — 격자 해상도만큼 여유를 두고 확인
      for (const p of line.points) {
        const deepInside =
          p.x > -10 + 2 && p.x < 10 - 2 && p.y > -10 + 2 && p.y < 10 - 2;
        expect(deepInside).toBe(false);
      }
      expect(line.speedRatio).toBeGreaterThan(0);
    }
  });
});

describe("flowDirection — northAngle 보정", () => {
  it("도면 Y+가 정북에서 반시계 30° 돌아간 경우 흐름 벡터도 함께 회전한다", () => {
    const f0 = flowDirection(0, 0);
    expect(f0.x).toBeCloseTo(0, 6);
    expect(f0.y).toBeCloseTo(-1, 6);
    const f30 = flowDirection(0, 30);
    // 진북 남향 흐름 (0,-1)을 반시계 30° 회전 → (sin30, -cos30)
    expect(f30.x).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(f30.y).toBeCloseTo(-Math.cos(Math.PI / 6), 6);
  });
});
