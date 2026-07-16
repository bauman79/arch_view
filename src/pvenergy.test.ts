import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildWorkbook } from "./excel";
import { parseEpw, type EpwData } from "./epw";
import { faceLabel } from "./pv";
import { runPvEnergyAnalysis, type PvEnergyResult } from "./pvenergy";
import {
  defaultProject,
  type Building,
  type Point2,
  type Project,
} from "./types";
import XLSX from "xlsx-js-style";

/**
 * M5 PV 절대평가 검증 (plan.md 7장 M5 + M5 요구사항):
 * 무차폐 단일 인접건물(10×10m, 5층×3m) × 인천 TMY:
 * 검증 2 — 수평면(지붕) kWh/m²가 PVWatts 인천 기준(1,200~1,400)의 ±20% 이내
 * 검증 3 — 북향 수직벽 < 남향 수직벽 (절대값에서도 패턴 유지)
 * + 산란 모델(지붕=DHI 전량, 벽=절반), 차폐 반영, 엑셀 kWh 컬럼
 */

function mkAdjBuilding(): Building {
  const footprint: Point2[] = [
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

/** 면 라벨별 평균 연간 kWh/m² */
function meanKwhByFace(r: PvEnergyResult): Map<string, number> {
  const sum = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < r.cells.length; i++) {
    const label = faceLabel(r.cells[i], 0);
    const acc = sum.get(label) ?? { s: 0, n: 0 };
    acc.s += r.results[i].totalKwh;
    acc.n++;
    sum.set(label, acc);
  }
  return new Map([...sum].map(([k, v]) => [k, v.s / v.n]));
}

let epw: EpwData;
let result: PvEnergyResult;
let project: Project;

beforeAll(async () => {
  epw = parseEpw(
    readFileSync(
      fileURLToPath(
        new URL("../data/KOR_Inchon.471120_IWEC.epw", import.meta.url),
      ),
      "utf-8",
    ),
  );
  project = mkProject();
  result = await runPvEnergyAnalysis(project, epw, "인천");
}, 120_000);

describe("M5 절대평가 — 격자·구성", () => {
  it("모든 벽면(4방위)과 지붕이 포함되고 직달+산란=합계", () => {
    const labels = new Set(result.cells.map((c) => faceLabel(c, 0)));
    expect(labels).toEqual(
      new Set(["지붕", "남측 벽면", "북측 벽면", "동측 벽면", "서측 벽면"]),
    );
    for (const r of result.results) {
      expect(r.totalKwh).toBeCloseTo(r.directKwh + r.diffuseKwh, 6);
      expect(r.directKwh).toBeGreaterThanOrEqual(0);
    }
  });

  it("레이캐스팅 시각은 고도>5°만 — 8,760보다 훨씬 적다", () => {
    expect(result.rayHourCount).toBeGreaterThan(2000);
    expect(result.rayHourCount).toBeLessThan(4500);
  });
});

describe("검증 2 — 무차폐 지붕 kWh/m² (PVWatts 인천 대조)", () => {
  it("지붕 평균이 1,200~1,400의 ±20%(960~1,680 kWh/m²·년) 이내", () => {
    const roof = meanKwhByFace(result).get("지붕")!;
    expect(roof).toBeGreaterThan(960);
    expect(roof).toBeLessThan(1680);
  });

  it("지붕 평균 ≈ EPW 연간 GHI (등식 Σ(DNI·sinα+DHI) ≈ GHI, ±15%)", () => {
    const roof = meanKwhByFace(result).get("지붕")!;
    expect(roof).toBeGreaterThan(epw.annual.ghiKwh * 0.85);
    expect(roof).toBeLessThan(epw.annual.ghiKwh * 1.15);
  });
});

describe("검증 3 — 방위별 절대값 패턴", () => {
  it("북향 수직벽 < 남향 수직벽", () => {
    const mean = meanKwhByFace(result);
    expect(mean.get("북측 벽면")!).toBeLessThan(mean.get("남측 벽면")!);
  });

  it("남향 > 동·서향 > 북향 (Ladybug sanity — 절대값 유지)", () => {
    const mean = meanKwhByFace(result);
    const s = mean.get("남측 벽면")!;
    const e = mean.get("동측 벽면")!;
    const w = mean.get("서측 벽면")!;
    const n = mean.get("북측 벽면")!;
    expect(s).toBeGreaterThan(e);
    expect(s).toBeGreaterThan(w);
    expect(e).toBeGreaterThan(n);
    expect(w).toBeGreaterThan(n);
  });

  it("북향 벽도 산란 덕에 0은 아니다 (등방성 하늘 = DHI의 절반 이상)", () => {
    const north = meanKwhByFace(result).get("북측 벽면")!;
    expect(north).toBeGreaterThanOrEqual(epw.annual.dhiKwh * 0.5 - 1);
  });
});

describe("산란(등방성) 모델", () => {
  it("지붕 산란 = 연간 DHI 전량, 수직벽 산란 = 절반", () => {
    const roofIdx = result.cells.findIndex((c) => c.surface === "roof");
    const wallIdx = result.cells.findIndex((c) => c.surface === "wall");
    expect(result.results[roofIdx].diffuseKwh).toBeCloseTo(
      epw.annual.dhiKwh,
      1,
    );
    expect(result.results[wallIdx].diffuseKwh).toBeCloseTo(
      epw.annual.dhiKwh / 2,
      1,
    );
  });
});

describe("차폐 반영", () => {
  it("남측에 높은 건물이 서면 남향 벽 직달이 감소한다", async () => {
    const p = mkProject();
    const blocker: Building = {
      ...mkAdjBuilding(),
      id: "blocker",
      name: "차폐건물",
      type: "계획주동",
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
    const blocked = await runPvEnergyAnalysis(p, epw, "인천");
    const southDirect = (r: PvEnergyResult) => {
      let s = 0;
      for (let i = 0; i < r.cells.length; i++) {
        if (
          r.cells[i].buildingId === "adj-1" &&
          faceLabel(r.cells[i], 0) === "남측 벽면"
        ) {
          s += r.results[i].directKwh;
        }
      }
      return s;
    };
    expect(southDirect(blocked)).toBeLessThan(southDirect(result) * 0.7);
  }, 120_000);
});

describe("엑셀 PV 시트 — M5 kWh 컬럼", () => {
  it("헤더에 kWh 컬럼이 있고 M5만 실행해도 행이 채워진다", () => {
    const wb = buildWorkbook(mkProject(), null, null, null, result);
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const ws = XLSX.read(buf, { type: "array" }).Sheets["PV 결과"];
    expect(ws["H1"]?.v).toBe("평균 kWh/㎡·년");
    expect(ws["I1"]?.v).toBe("최대 kWh/㎡·년");
    expect(ws["A2"]?.v).toBe("인접건물 1");
    expect(ws["H2"]?.t).toBe("n");
    expect(ws["H2"]?.v).toBeGreaterThan(0);
  });
});
