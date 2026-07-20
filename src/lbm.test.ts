import { describe, expect, it } from "vitest";
import {
  assembleLbmResult,
  buildLbmDomain,
  chooseLbmGridM,
  computeLbmMetrics,
  lbmDxfToLocal,
  lbmLocalToDxf,
  lbmToWindField,
  LBM_AUTO_MAX_CELLS,
  LBM_CONV_STREAK,
  LBM_SHADOW_RATIO,
  LBM_U_LAT,
  runLbmSync,
} from "./lbm";
import { defaultProject, type Building, type Point2 } from "./types";

/**
 * M10 LBM 검증.
 * - 균일류 보존: 장애물 없는 도메인에서 유입 평형분포가 정확히 정상해 —
 *   Zou-He 유입·zero-gradient 유출·상하 슬립이 균일류를 깨지 않는지 (BC 정합성).
 * - 단일 사각 건물: 측면 가속(협곡효과) > 1, 후류 감속 < 1, 건물 내부 0 —
 *   D2Q9 유동의 정성적 패턴 확인.
 * - 좌표 변환 round-trip, 자동 격자, 지표 계산 손계산 대조.
 */

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

const site = defaultProject().site;

describe("buildLbmDomain — 흐름 정렬 격자", () => {
  it("건물 중심 셀은 solid, 로컬↔DXF 변환은 round-trip", () => {
    const b = mkBuilding("b1", rect(-10, -10, 10, 10));
    // 서풍(270°) → 흐름 동쪽(+x) → angle=0, 로컬=DXF
    const d = buildLbmDomain([b], site, 270, 2);
    expect(Math.abs(d.angle)).toBeLessThan(1e-9);
    const ix = Math.round((0 - d.lx0) / d.gridM);
    const iy = Math.round((0 - d.ly0) / d.gridM);
    expect(d.solid[iy * d.nx + ix]).toBe(1);
    expect(d.fluidCells).toBeLessThan(d.nx * d.ny);

    // 북풍(0°) → 흐름 남쪽 — 임의 점 round-trip
    const dn = buildLbmDomain([b], site, 0, 2);
    const p = lbmLocalToDxf(dn, 12.3, -4.5);
    const back = lbmDxfToLocal(dn, p.x, p.y);
    expect(back.x).toBeCloseTo(12.3, 9);
    expect(back.y).toBeCloseTo(-4.5, 9);
  });

  it("북풍(0°)에서도 DXF상 건물 중심이 solid로 매핑된다", () => {
    const b = mkBuilding("b1", rect(5, 5, 25, 25)); // 중심 (15,15)
    const d = buildLbmDomain([b], site, 0, 2);
    const loc = lbmDxfToLocal(d, 15, 15);
    const ix = Math.round((loc.x - d.lx0) / d.gridM);
    const iy = Math.round((loc.y - d.ly0) / d.gridM);
    expect(d.solid[iy * d.nx + ix]).toBe(1);
  });
});

describe("chooseLbmGridM — 자동 해상도", () => {
  it("작은 대지는 2m, 큰 대지는 3~4m 이상으로 커진다", () => {
    const small = mkBuilding("s", rect(-10, -10, 10, 10));
    expect(chooseLbmGridM([small], site, 270)).toBe(2);
    const big = mkBuilding("b", rect(0, 0, 600, 600));
    const g = chooseLbmGridM([big], site, 270);
    expect(g).toBeGreaterThanOrEqual(3);
    // 선택된 격자로 만든 도메인이 셀 상한을 넘지 않는다 (8m 상한 도달 제외)
    const d = buildLbmDomain([big], site, 270, g);
    if (g < 8) expect(d.nx * d.ny).toBeLessThanOrEqual(LBM_AUTO_MAX_CELLS);
  });
});

describe("LbmSolver — 균일류 보존 (BC 정합성)", () => {
  it("장애물 없으면 유입 평형분포가 정상해 — 연속 잔차 0으로 즉시 수렴", () => {
    const d = buildLbmDomain([], site, 270, 4);
    const { solver, steps, converged } = runLbmSync(d, 100);
    expect(converged).toBe(true);
    expect(steps).toBe(LBM_CONV_STREAK); // 잔차 0이 첫 스텝부터 이어진다
    const ratio = solver.speedRatio();
    for (let i = 0; i < ratio.length; i++) {
      expect(ratio[i]).toBeCloseTo(1, 3);
      expect(Math.abs(solver.uy[i])).toBeLessThan(1e-6);
    }
  });
});

describe("LbmSolver — 단일 사각 건물 유동", () => {
  // 20×20m 건물, 서풍(흐름 +x), 2m 격자 — 테스트 전역에서 한 번만 수렴시켜 재사용
  const b = mkBuilding("b1", rect(-10, -10, 10, 10));
  const domain = buildLbmDomain([b], site, 270, 2);
  const run = runLbmSync(domain, 4000);
  const ratio = run.solver.speedRatio();
  const at = (x: number, y: number) => {
    const ix = Math.round((x - domain.lx0) / domain.gridM);
    const iy = Math.round((y - domain.ly0) / domain.gridM);
    return ratio[iy * domain.nx + ix];
  };

  it("수렴한다 (연속 10스텝 잔차 < 0.1%)", () => {
    expect(run.converged).toBe(true);
    expect(run.steps).toBeGreaterThan(LBM_CONV_STREAK);
  });

  it("건물 내부 속도 0, 후류(배면)는 유입보다 느리고 측면은 가속", () => {
    expect(at(0, 0)).toBe(0); // 건물 내부
    const wake = at(16, 0); // 배면 3셀 뒤
    expect(wake).toBeLessThan(0.7);
    const side = Math.max(at(0, 16), at(0, -16)); // 측면 3셀 옆
    expect(side).toBeGreaterThan(1.0); // 협곡효과 — 블로키지에 의한 가속
    expect(side).toBeGreaterThan(wake);
  });

  it("유입 경계는 Zou-He 지정 속도 (u≈U_LAT, v≈0)를 유지한다", () => {
    const midY = Math.floor(domain.ny / 2);
    const cell = midY * domain.nx; // ix=0
    expect(run.solver.ux[cell]).toBeCloseTo(LBM_U_LAT, 3);
    expect(Math.abs(run.solver.uy[cell])).toBeLessThan(0.005);
  });

  it("지표: maxRatio>1(협곡), 바람 그늘 면적>0", () => {
    const m = computeLbmMetrics(domain, ratio);
    expect(m.maxRatio).toBeGreaterThan(1.0);
    expect(m.shadowAreaM2).toBeGreaterThan(0);
    expect(m.meanRatio).toBeGreaterThan(0.5);
  });

  it("assembleLbmResult — 스트림라인이 생성되고 결과가 조립된다", () => {
    const res = assembleLbmResult(domain, run.solver.ux, run.solver.uy, [b], {
      windDirDeg: 270,
      windDirSource: "manual",
      windSpeedMs: 3.1,
      steps: run.steps,
      converged: run.converged,
    });
    expect(res.streamlines.length).toBeGreaterThan(5);
    expect(res.maxRatio).toBeGreaterThan(1.0);
    expect(res.shadowAreaM2).toBeGreaterThan(0);
    expect(res.windSpeedMs).toBeCloseTo(3.1, 6);
    // 스트림라인이 건물 깊숙이 통과하지 않는다 — 경계 셀(격자 이산화) 1셀 여유
    for (const line of res.streamlines) {
      for (const p of line.points) {
        const deepInside = p.x > -8 && p.x < 8 && p.y > -8 && p.y < 8;
        expect(deepInside).toBe(false);
      }
    }
  });
});

describe("lbmToWindField — DXF 재샘플링 어댑터", () => {
  it("빈 도메인 북풍: DXF 벡터가 남향(0,-1)·비율 1로 정규화된다", () => {
    const d = buildLbmDomain([], site, 0, 4);
    const { solver } = runLbmSync(d, 50);
    const field = lbmToWindField(d, solver.ux, solver.uy, []);
    expect(field.windSpeedMs).toBe(1);
    // 도메인 중앙 셀
    const ix = Math.floor(field.nx / 2);
    const iy = Math.floor(field.ny / 2);
    const idx = iy * field.nx + ix;
    expect(field.u[idx]).toBeCloseTo(0, 2);
    expect(field.v[idx]).toBeCloseTo(-1, 2);
    expect(field.flowDir.x).toBeCloseTo(0, 6);
    expect(field.flowDir.y).toBeCloseTo(-1, 6);
  });
});

describe("computeLbmMetrics — 손계산 대조", () => {
  it("합성 4셀: max·shadow·mean이 정확", () => {
    const d = {
      nx: 2,
      ny: 2,
      gridM: 2,
      lx0: 0,
      ly0: 0,
      angle: 0,
      solid: new Uint8Array([0, 0, 0, 1]),
      fluidCells: 3,
    };
    const ratio = new Float32Array([1.5, 0.4, 0.8, 0]);
    const m = computeLbmMetrics(d, ratio);
    expect(m.maxRatio).toBeCloseTo(1.5, 6);
    expect(m.shadowAreaM2).toBeCloseTo(4, 6); // 0.4 < 0.5 → 1셀 × 2m²
    expect(m.meanRatio).toBeCloseTo((1.5 + 0.4 + 0.8) / 3, 5);
    expect(LBM_SHADOW_RATIO).toBe(0.5);
  });
});
