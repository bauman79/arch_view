import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { faceLabel, pvResultToCsv, runPvAnalysis, type PvResult } from "./pv";
import { localDate, sunPosition } from "./sun";
import {
  defaultProject,
  type Building,
  type Point2,
  type Project,
} from "./types";

/**
 * M4 PV 상대평가 검증 (plan.md 7장 + M4 요구사항).
 * 무차폐 단일 인접건물(10×10m, 5층×3m)에 대해:
 * 1. 지붕: 입사각 보정 후 유효량이 벽면보다 많아야 함 (하지 정오 cosθ 우위 포함)
 * 2. 북향 수직벽: 유효량 ≈ 0 (8~16시 창에서 태양이 닿지 않음)
 * 3. 남향 수직벽: 동지 > 하지 (태양고도가 낮을수록 수직면 cosθ 큼)
 * 4. CSV: 셀 좌표·법선·직달시간·유효량 포함
 * + Ladybug sanity: 남향 > 동·서향 > 북향 순서 (plan.md M4 검증)
 */

function mkAdjBuilding(): Building {
  const footprint: Point2[] = [
    // CCW 10×10 정사각형
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  return {
    id: "adj-1",
    name: "인접건물 1",
    type: "인접건물",
    massType: "custom",
    footprint,
    floors: 5,
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

function mkProject(): Project {
  const p = defaultProject();
  p.buildings = [mkAdjBuilding()];
  p.analysis.gridSize = 2; // 테스트 속도용
  return p;
}

/** 면 라벨별 평균 유효 직달량 (h) */
function meanEffectiveByFace(r: PvResult): Map<string, number> {
  const sum = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < r.cells.length; i++) {
    const label = faceLabel(r.cells[i], 0);
    const acc = sum.get(label) ?? { s: 0, n: 0 };
    acc.s += r.results[i].effectiveHours;
    acc.n++;
    sum.set(label, acc);
  }
  return new Map([...sum].map(([k, v]) => [k, v.s / v.n]));
}

/** 면 라벨별 대표일 평균 유효량 (h) — dayIdx: 0춘분 1하지 2추분 3동지 */
function meanPerDayByFace(r: PvResult, face: string, dayIdx: number): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < r.cells.length; i++) {
    if (faceLabel(r.cells[i], 0) !== face) continue;
    s += r.results[i].perDayEffective[dayIdx];
    n++;
  }
  return n > 0 ? s / n : 0;
}

let result: PvResult;
let project: Project;

beforeAll(async () => {
  project = mkProject();
  result = await runPvAnalysis(project);
});

describe("M4 PV 상대평가 — 격자·정규화", () => {
  it("모든 벽면(4방위)과 지붕이 분석 대상에 포함된다", () => {
    const labels = new Set(result.cells.map((c) => faceLabel(c, 0)));
    expect(labels).toEqual(
      new Set(["지붕", "남측 벽면", "북측 벽면", "동측 벽면", "서측 벽면"]),
    );
  });

  it("상대효율은 0~1이고 최대값 셀의 score는 1이다", () => {
    expect(result.maxEffective).toBeGreaterThan(0);
    let max = 0;
    for (const r of result.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      max = Math.max(max, r.score);
    }
    expect(max).toBeCloseTo(1, 6);
  });
});

describe("검증 1 — 지붕 vs 벽면 (입사각 보정)", () => {
  it("하지 정오: 태양벡터·지붕법선 내적 > 태양벡터·남벽법선 내적", () => {
    // 서울 하지 남중 무렵(12:30 KST) 고도 ≈ 76° → 수평면 cosθ ≈ 0.97 우위
    const pos = sunPosition(localDate("2026-06-21", 750), 37.57, 126.98);
    expect(pos.dir).not.toBeNull();
    const up = new THREE.Vector3(0, 1, 0);
    const southNormal = new THREE.Vector3(0, 0, 1); // three 좌표 z+=남
    expect(up.dot(pos.dir!)).toBeGreaterThan(southNormal.dot(pos.dir!));
  });

  it("지붕 평균 유효량 > 모든 벽면 평균 유효량", () => {
    const mean = meanEffectiveByFace(result);
    const roof = mean.get("지붕")!;
    for (const face of ["남측 벽면", "북측 벽면", "동측 벽면", "서측 벽면"]) {
      expect(roof).toBeGreaterThan(mean.get(face)!);
    }
  });
});

describe("검증 2 — 북향 수직벽 유효량 ≈ 0", () => {
  it("북향 벽 평균 유효량이 남향 벽의 5% 미만", () => {
    const mean = meanEffectiveByFace(result);
    expect(mean.get("북측 벽면")!).toBeLessThan(mean.get("남측 벽면")! * 0.05);
  });
});

describe("검증 3 — 남향 수직벽 계절 패턴", () => {
  it("남향 벽: 동지 유효량 > 하지 유효량 (태양고도 차이)", () => {
    const winter = meanPerDayByFace(result, "남측 벽면", 3);
    const summer = meanPerDayByFace(result, "남측 벽면", 1);
    expect(winter).toBeGreaterThan(summer);
  });

  it("지붕: 하지 유효량 > 동지 유효량 (반대 패턴)", () => {
    const winter = meanPerDayByFace(result, "지붕", 3);
    const summer = meanPerDayByFace(result, "지붕", 1);
    expect(summer).toBeGreaterThan(winter);
  });
});

describe("Ladybug sanity — 방위별 순서 (plan.md M4 검증)", () => {
  it("남향 > 동·서향 > 북향", () => {
    const mean = meanEffectiveByFace(result);
    const s = mean.get("남측 벽면")!;
    const e = mean.get("동측 벽면")!;
    const w = mean.get("서측 벽면")!;
    const n = mean.get("북측 벽면")!;
    expect(s).toBeGreaterThan(e);
    expect(s).toBeGreaterThan(w);
    expect(e).toBeGreaterThan(n);
    expect(w).toBeGreaterThan(n);
  });
});

describe("검증 4 — CSV 내보내기", () => {
  it("헤더에 좌표·법선·직달시간·유효량·상대효율 컬럼이 있다", () => {
    const csv = pvResultToCsv(result, project.buildings, 0);
    const header = csv.split("\n")[0];
    for (const col of [
      "건물",
      "면",
      "x(m)",
      "y(m)",
      "z(m)",
      "nx",
      "ny",
      "nz",
      "직달시간(h)",
      "유효직달(h)",
      "상대효율(%)",
    ]) {
      expect(header).toContain(col);
    }
  });

  it("행 수 = 셀 수 + 헤더 1행, 값이 숫자로 파싱된다", () => {
    const csv = pvResultToCsv(result, project.buildings, 0);
    const lines = csv.split("\n");
    expect(lines.length).toBe(result.cells.length + 1);
    const cols = lines[1].split(",");
    expect(cols.length).toBe(11);
    // x,y,z,nx,ny,nz,직달,유효,효율 — 숫자 필드 검사
    for (const v of cols.slice(2)) {
      expect(Number.isFinite(parseFloat(v))).toBe(true);
    }
  });

  it("지붕 셀의 법선은 (0,0,1) — DXF 좌표(z=상)로 내보낸다", () => {
    const csv = pvResultToCsv(result, project.buildings, 0);
    const lines = csv.split("\n");
    const roofLine = lines.find((l) => l.includes("지붕"))!;
    const cols = roofLine.split(",");
    expect(parseFloat(cols[5])).toBeCloseTo(0, 3); // nx
    expect(parseFloat(cols[6])).toBeCloseTo(0, 3); // ny
    expect(parseFloat(cols[7])).toBeCloseTo(1, 3); // nz
  });
});

describe("차폐 반영", () => {
  it("남측에 높은 건물이 서면 남향 벽 유효량이 감소한다", async () => {
    const p = mkProject();
    const blocker: Building = {
      ...mkAdjBuilding(),
      id: "blocker",
      name: "차폐건물",
      type: "계획주동",
      // 대상 건물 바로 남측(도면 y−)에 인접, 2배 높이
      footprint: [
        { x: 0, y: -14 },
        { x: 10, y: -14 },
        { x: 10, y: -4 },
        { x: 0, y: -4 },
      ],
      floors: 10,
      analysisTarget: false,
    };
    p.buildings.push(blocker);
    const blocked = await runPvAnalysis(p);
    const south = (r: PvResult) => {
      let s = 0;
      for (let i = 0; i < r.cells.length; i++) {
        if (
          r.cells[i].buildingId === "adj-1" &&
          faceLabel(r.cells[i], 0) === "남측 벽면"
        ) {
          s += r.results[i].effectiveHours;
        }
      }
      return s;
    };
    expect(south(blocked)).toBeLessThan(south(result) * 0.7);
  });
});
