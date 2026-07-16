import { describe, expect, it } from "vitest";
import XLSX from "xlsx-js-style";
import { buildWorkbook } from "./excel";
import { createTemplateBuilding } from "./massing";
import type { NorthSetbackResult } from "./northsetback";
import type { PvResult } from "./pv";
import type { SunHoursResult } from "./sunhours";
import { defaultProject, type Project } from "./types";

/**
 * M6 엑셀 내보내기 검증 (plan.md 7장 M6):
 * 내보낸 xlsx를 다시 파싱해 화면 집계값과 일치하는지 round-trip 테스트.
 * 시트 4개 · 헤더 · 숫자 셀 타입("n") · 헤더 굵게 확인.
 */

function mkProject(): Project {
  const p = defaultProject();
  const b = createTemplateBuilding("slab", 4, 1, 1); // 판상형 1
  b.floors = 10;
  b.pilotiFloors = 1; // → 주거층수 9
  // M6.8: unitMix는 "층당 세대수" 직접 입력 — 59㎡ 2세대/층, 84㎡·101㎡ 1세대/층씩
  // → 9층 × (2/1/1) = 18/9/9 = 36세대
  b.unitMix = [
    { unitType: "59㎡", countPerFloor: 2 },
    { unitType: "84㎡", countPerFloor: 1 },
    { unitType: "101㎡", countPerFloor: 1 },
  ];
  p.buildings = [b];
  p.site.siteAreaM2 = 5000;
  return p;
}

/** write → read round-trip */
function roundTrip(wb: XLSX.WorkBook): XLSX.WorkBook {
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return XLSX.read(buf, { type: "array" });
}

function cell(ws: XLSX.WorkSheet, addr: string): XLSX.CellObject | undefined {
  return ws[addr] as XLSX.CellObject | undefined;
}

describe("엑셀 내보내기 round-trip", () => {
  it("시트 6개 (배치 개요 · 일조권 · 정북사선 · PV · 바람길분석 · 일조시간)", () => {
    const wb = roundTrip(buildWorkbook(mkProject(), null, null, null));
    expect(wb.SheetNames).toEqual([
      "배치 개요",
      "일조권 검토 결과",
      "정북사선 결과",
      "PV 결과",
      "바람길분석",
      "일조시간",
    ]);
  });

  it("배치 개요: 헤더·평형별 행 분리·세대수·숫자 타입", () => {
    const wb = roundTrip(buildWorkbook(mkProject(), null, null, null));
    const ws = wb.Sheets["배치 개요"];
    // 헤더 (한글 깨짐 없이 왕복) — 평형별 행 분리 구조
    expect(cell(ws, "A1")?.v).toBe("건물명");
    expect(cell(ws, "B1")?.v).toBe("주동타입");
    expect(cell(ws, "C1")?.v).toBe("미러");
    expect(cell(ws, "G1")?.v).toBe("평형");
    expect(cell(ws, "H1")?.v).toBe("층당세대수");
    expect(cell(ws, "I1")?.v).toBe("총 세대수");
    // 첫 행: 판상형 1 — 10층·필로티1(주거9층), 59㎡ 2세대/층 × 9층 = 18
    expect(cell(ws, "A2")?.v).toBe("판상형 1");
    expect(cell(ws, "B2")?.v).toBe("판상형");
    expect(cell(ws, "C2")?.v).toBe("없음"); // 미러 미적용
    expect(cell(ws, "D2")?.v).toBe(10);
    expect(cell(ws, "E2")?.v).toBe(1);
    expect(cell(ws, "G2")?.v).toBe("59㎡");
    expect(cell(ws, "H2")?.v).toBe(2);
    expect(cell(ws, "I2")?.v).toBe(18);
    expect(cell(ws, "I2")?.t).toBe("n"); // 숫자 타입
    // 건축면적 528㎡ / 대지 5000㎡ → 건폐율 10.56%, 용적률 528×9/5000 = 95.04% (첫 행에만)
    expect(cell(ws, "J2")?.v).toBeCloseTo(528, 1);
    expect(cell(ws, "L2")?.v).toBeCloseTo(10.56, 2);
    expect(cell(ws, "L2")?.t).toBe("n");
    expect(cell(ws, "M2")?.v).toBeCloseTo(95.04, 2);
    // 나머지 평형은 별도 행 — 건물명 반복, 건물 단위 값(층수·면적)은 빈 칸
    expect(cell(ws, "A3")?.v).toBe("판상형 1");
    expect(cell(ws, "G3")?.v).toBe("84㎡");
    expect(cell(ws, "I3")?.v).toBe(9);
    expect(cell(ws, "D3")).toBeUndefined();
    expect(cell(ws, "J3")).toBeUndefined();
    expect(cell(ws, "A4")?.v).toBe("판상형 1");
    expect(cell(ws, "G4")?.v).toBe("101㎡");
    expect(cell(ws, "I4")?.v).toBe(9);
    // 합계 행
    expect(cell(ws, "A5")?.v).toBe("합계 (계획주동)");
    expect(cell(ws, "I5")?.v).toBe(36);
  });

  it("세대수 집계 섹션: 전체 세대수 합계 + 타입별 세대수", () => {
    const wb = roundTrip(buildWorkbook(mkProject(), null, null, null));
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets["배치 개요"],
      { header: 1 },
    );
    const head = rows.findIndex((r) => r[0] === "세대수 집계");
    expect(head).toBeGreaterThan(0);
    expect(rows[head + 1]).toEqual(["전체 세대수", 36]);
    expect(rows[head + 2]).toEqual(["59㎡", 18]);
    expect(rows[head + 3]).toEqual(["84㎡", 9]);
    expect(rows[head + 4]).toEqual(["101㎡", 9]);
  });

  it("층수 변경 시 총 세대수가 자동 재계산된다 (버그 수정 검증)", () => {
    const p = mkProject();
    const b = p.buildings[0];
    b.floors = 20; // 필로티 1 → 주거층수 19
    const wb = roundTrip(buildWorkbook(p, null, null, null));
    const ws = wb.Sheets["배치 개요"];
    // 19층 × (2/1/1) = 38/19/19 = 76세대
    expect(cell(ws, "I2")?.v).toBe(38); // 59㎡ 행
    expect(cell(ws, "I3")?.v).toBe(19); // 84㎡ 행
    expect(cell(ws, "I4")?.v).toBe(19); // 101㎡ 행
    expect(cell(ws, "A5")?.v).toBe("합계 (계획주동)");
    expect(cell(ws, "I5")?.v).toBe(76);
  });

  it("DXF(custom) 주동은 평형 구성으로 표기되고, 타입별 합계가 맞다", () => {
    const p = mkProject();
    const dxfB = createTemplateBuilding("slab", 4, 1, 2);
    dxfB.name = "계획주동_A_1";
    dxfB.massType = "custom"; // DXF 폴리곤 주동
    dxfB.floors = 15;
    dxfB.unitMix = [
      { unitType: "59㎡", countPerFloor: 2 },
      { unitType: "84㎡", countPerFloor: 2 },
    ];
    p.buildings.push(dxfB);
    const wb = roundTrip(buildWorkbook(p, null, null, null));
    const ws = wb.Sheets["배치 개요"];
    // custom이 아니라 평형 구성이 보인다 (판상형 3행 다음 = 5행)
    expect(cell(ws, "A5")?.v).toBe("계획주동_A_1");
    expect(cell(ws, "B5")?.v).toBe("59㎡+84㎡");
    expect(cell(ws, "G5")?.v).toBe("59㎡");
    expect(cell(ws, "I5")?.v).toBe(30); // 15층 × 2세대
    expect(cell(ws, "G6")?.v).toBe("84㎡");
    expect(cell(ws, "I6")?.v).toBe(30);
    // 전체 합계 36 + 60 = 96
    expect(cell(ws, "A7")?.v).toBe("합계 (계획주동)");
    expect(cell(ws, "I7")?.v).toBe(96);
    // 타입별 집계: 59㎡ = 18(판상형) + 30(custom) = 48, 84㎡ = 9 + 30 = 39
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1 });
    const head = rows.findIndex((r) => r[0] === "세대수 집계");
    expect(rows[head + 1]).toEqual(["전체 세대수", 96]);
    expect(rows[head + 2]).toEqual(["59㎡", 48]);
    expect(rows[head + 3]).toEqual(["84㎡", 39]);
    expect(rows[head + 4]).toEqual(["101㎡", 9]);
  });

  it("인접건물은 배치 개요에서 제외된다", () => {
    const p = mkProject();
    const adj = createTemplateBuilding("slab", 4, 1, 9);
    adj.name = "인접건물 A";
    adj.type = "인접건물";
    adj.unitsPerFloor = 0;
    adj.unitMix = [];
    p.buildings.push(adj);
    const wb = roundTrip(buildWorkbook(p, null, null, null));
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["배치 개요"], { header: 1 });
    expect(rows.some((r) => r[0] === "인접건물 A")).toBe(false);
    expect(rows.some((r) => r[0] === "판상형 1")).toBe(true);
  });

  it("헤더 굵게 (쓰기 전 워크북에서 스타일 확인)", () => {
    const wb = buildWorkbook(mkProject(), null, null, null);
    const ws = wb.Sheets["배치 개요"];
    expect((ws["A1"] as any).s?.font?.bold).toBe(true);
    expect((wb.Sheets["일조권 검토 결과"]["A1"] as any).s?.font?.bold).toBe(true);
    expect((wb.Sheets["정북사선 결과"]["A1"] as any).s?.font?.bold).toBe(true);
    expect((wb.Sheets["PV 결과"]["A1"] as any).s?.font?.bold).toBe(true);
  });

  it("분석 미실행이면 일조권·정북사선·PV 시트는 헤더 + 미실행 표기", () => {
    const wb = roundTrip(buildWorkbook(mkProject(), null, null, null));
    expect(cell(wb.Sheets["일조권 검토 결과"], "A1")?.v).toBe("건물명");
    expect(cell(wb.Sheets["일조권 검토 결과"], "A2")?.v).toBe("(일조권 검토 미실행)");
    expect(cell(wb.Sheets["정북사선 결과"], "A1")?.v).toBe("건물명");
    expect(cell(wb.Sheets["정북사선 결과"], "A2")?.v).toBe("(정북사선 검토 미실행)");
    expect(cell(wb.Sheets["PV 결과"], "A2")?.v).toBe("(PV 분석 미실행)");
  });

  it("일조권 검토 결과가 있으면 인접건물별 벽면·지붕 확보율이 채워진다", () => {
    const sunHours = {
      rule: "either",
      timeStep: 10,
      samples: [],
      cells: [],
      results: [],
      summaries: [
        {
          buildingId: "adj-1",
          name: "인접건물 A",
          wall: { passCells: 132, totalCells: 210 },
          roof: { passCells: 88, totalCells: 96 },
        },
      ],
    } as unknown as SunHoursResult;

    const wb = roundTrip(buildWorkbook(mkProject(), sunHours, null, null));
    const ws = wb.Sheets["일조권 검토 결과"];
    expect(cell(ws, "A2")?.v).toBe("인접건물 A");
    expect(cell(ws, "B2")?.v).toBe("벽면");
    expect(cell(ws, "C2")?.v).toBe(210);
    expect(cell(ws, "D2")?.v).toBe(132);
    expect(cell(ws, "E2")?.v).toBeCloseTo(62.9, 1);
    expect(cell(ws, "E2")?.t).toBe("n");
    expect(cell(ws, "B3")?.v).toBe("지붕");
    expect(cell(ws, "E3")?.v).toBeCloseTo(91.7, 1);
  });

  it("정북사선·PV 결과가 있으면 건물별 행이 채워진다", () => {
    const northSetback = {
      nearRatio: 1.5,
      farRatio: 1.25,
      farConst: 3.6,
      threshold: 9,
      violations: 0,
      checks: [
        {
          buildingId: "plan-1",
          buildingName: "판상형 1",
          origin: { x: 0, y: 0 },
          point: { x: 0, y: 20 },
          source: "ADJ_BOUNDARY",
          distance: 20,
          allowedHeight: 28.6,
          actualHeight: 25.2,
          pass: true,
        },
      ],
    } as unknown as NorthSetbackResult;
    const pv = {
      dates: [],
      samplesPerDay: 48,
      cells: [],
      results: [],
      maxEffective: 20,
      summaries: [
        {
          buildingId: "adj-1",
          name: "인접건물 A",
          faces: [
            {
              face: "지붕",
              cellCount: 25,
              areaM2: 100,
              topAreaM2: 80,
              meanScorePct: 91.2,
              maxScorePct: 100,
            },
          ],
        },
      ],
    } as unknown as PvResult;

    const wb = roundTrip(buildWorkbook(mkProject(), null, northSetback, pv));
    const setbackWs = wb.Sheets["정북사선 결과"];
    expect(cell(setbackWs, "A2")?.v).toBe("판상형 1");
    expect(cell(setbackWs, "B2")?.v).toBe(20);
    expect(cell(setbackWs, "B2")?.t).toBe("n");
    expect(cell(setbackWs, "C2")?.v).toBe("인접대지경계선");
    expect(cell(setbackWs, "D2")?.v).toBeCloseTo(28.6, 1);
    expect(cell(setbackWs, "E2")?.v).toBeCloseTo(25.2, 1);
    expect(cell(setbackWs, "F2")?.v).toBe("적합");

    const pvWs = wb.Sheets["PV 결과"];
    expect(cell(pvWs, "A2")?.v).toBe("인접건물 A");
    expect(cell(pvWs, "B2")?.v).toBe("지붕");
    expect(cell(pvWs, "E2")?.v).toBeCloseTo(91.2, 1);
    expect(cell(pvWs, "E2")?.t).toBe("n");
    expect(cell(pvWs, "G2")?.v).toBe(80);
  });

  it("대지면적 미입력이면 건폐율·용적률 셀이 비고 '미입력' 표기", () => {
    const p = mkProject();
    p.site.siteAreaM2 = 0;
    const wb = roundTrip(buildWorkbook(p, null, null, null));
    const ws = wb.Sheets["배치 개요"];
    expect(cell(ws, "L2")).toBeUndefined(); // 건폐율 빈 칸
    // 대지면적 행
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    const siteRow = rows.find((r) => r[0] === "대지면적(㎡)");
    expect(siteRow?.[1]).toBe("미입력");
  });
});
