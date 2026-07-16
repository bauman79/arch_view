import XLSX from "xlsx-js-style";
import type { NorthSetbackResult } from "./northsetback";
import {
  coverageStats,
  footprintAreaM2,
  grossFloorAreaM2,
  MASS_TYPE_LABEL,
  totalUnits,
  unitBreakdown,
} from "./massing";
import type { PvResult } from "./pv";
import type { PvEnergyResult } from "./pvenergy";
import type { SunHoursResult } from "./sunhours";
import type { SunHoursMapResult } from "./sunhoursmap";
import { windDirLabel, type WindResult } from "./wind";
import { mirrorLabel, type Building, type Project, type SunHoursRule } from "./types";

/**
 * M6 — 엑셀(xlsx) 내보내기 (plan.md 6장).
 * 시트 4개: 배치 개요 / 일조권 검토 결과(수인한도, 인접건물) / 정북사선 결과 / PV 결과(M4 상대 + M5 절대 kWh).
 * xlsx는 내부가 UTF-8 zip이라 CSV와 달리 BOM 없이도 한글이 깨지지 않는다.
 * 숫자 셀은 숫자 타입(t:"n")으로, 헤더는 굵게(xlsx-js-style) 넣는다.
 */

type Cell = string | number | null;

const HEADER_STYLE = { font: { bold: true } };

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** aoa → 시트. boldRows에 해당하는 행 전체를 굵게 */
function sheetFromRows(
  rows: Cell[][],
  boldRows: number[],
  colWidths?: number[],
): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (const r of boldRows) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].s = HEADER_STYLE;
    }
  }
  if (colWidths) ws["!cols"] = colWidths.map((wch) => ({ wch }));
  return ws;
}

// ---------- 시트 1: 배치 개요 ----------

/** 계획주동 unitMix에 등장하는 전용면적 타입 컬럼 (등장 순서 유지) */
export function unitTypeColumns(buildings: Building[]): string[] {
  const seen: string[] = [];
  for (const b of buildings) {
    if (b.type !== "계획주동") continue;
    for (const m of b.unitMix) {
      if (!seen.includes(m.unitType)) seen.push(m.unitType);
    }
  }
  return seen;
}

export function buildOverviewRows(project: Project): Cell[][] {
  const { buildings, site } = project;
  const unitTypes = unitTypeColumns(buildings);
  const header: Cell[] = [
    "건물명",
    "구분",
    "주동타입",
    "미러",
    "층수",
    "필로티",
    "분절",
    "층당세대",
    "평형 층당세대수 합",
    "총 세대수(층수×층당)",
    ...unitTypes.map((t) => `${t} 세대`),
    "건축면적(㎡)",
    "연면적(㎡)",
    "건폐율(%)",
    "용적률(%)",
  ];
  const rows: Cell[][] = [header];

  const siteArea = site.siteAreaM2;
  const hasSite = siteArea > 0;

  for (const b of buildings) {
    const isPlan = b.type === "계획주동";
    const area = footprintAreaM2(b);
    const gfa = grossFloorAreaM2(b);
    const total = isPlan && b.unitsPerFloor > 0 ? totalUnits(b) : null;
    const mixPerFloor =
      isPlan && b.unitsPerFloor > 0
        ? b.unitMix.reduce((s, m) => s + Math.max(0, Math.round(m.countPerFloor)), 0)
        : null;
    const byType = new Map(
      unitBreakdown(b).map((u) => [u.unitType, u.count]),
    );
    rows.push([
      b.name,
      b.type,
      MASS_TYPE_LABEL[b.massType],
      mirrorLabel(b),
      b.floors,
      b.pilotiFloors,
      isPlan ? Math.max(1, b.segments) : null,
      isPlan && b.unitsPerFloor > 0 ? b.unitsPerFloor : null,
      mixPerFloor,
      total,
      ...unitTypes.map<Cell>((t) =>
        total !== null ? (byType.get(t) ?? 0) : null,
      ),
      round(area),
      round(gfa),
      // 건폐율·용적률은 계획주동만 (인접건물은 타 대지)
      isPlan && hasSite ? round((area / siteArea) * 100, 2) : null,
      isPlan && hasSite ? round((gfa / siteArea) * 100, 2) : null,
    ]);
  }

  // 합계 (계획주동 기준)
  const stats = coverageStats(buildings, siteArea);
  let totalSum = 0;
  const typeSum = new Map<string, number>();
  for (const b of buildings) {
    if (b.type !== "계획주동" || b.unitsPerFloor <= 0) continue;
    totalSum += totalUnits(b);
    for (const u of unitBreakdown(b)) {
      typeSum.set(u.unitType, (typeSum.get(u.unitType) ?? 0) + u.count);
    }
  }
  rows.push([
    "합계 (계획주동)",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    totalSum,
    ...unitTypes.map<Cell>((t) => typeSum.get(t) ?? 0),
    round(stats.coverageM2),
    round(stats.grossM2),
    stats.bcrPct !== null ? round(stats.bcrPct, 2) : null,
    stats.farPct !== null ? round(stats.farPct, 2) : null,
  ]);

  rows.push([]);
  rows.push(["대지면적(㎡)", hasSite ? siteArea : "미입력"]);
  rows.push([
    "비고",
    "연면적 = 건축면적 × 주거층수(필로티 제외) 근사 · 건폐율·용적률은 계획주동만 산입",
  ]);
  return rows;
}

// ---------- 시트 2: 일조권 검토 결과 (수인한도, 인접건물) ----------

const SUN_HOURS_RULE_LABEL: Record<SunHoursRule, string> = {
  either: "연속2h 또는 총4h",
  continuous: "연속 2h(9~15시)만",
  total: "총 4h(8~16시)만",
};

/** 대법원 수인한도 판례 — 인접건물 벽면·지붕별 확보 셀 수/비율 (정북사선과 별개 검토) */
export function buildSunHoursRows(result: SunHoursResult | null): Cell[][] {
  const header: Cell[] = ["건물명", "면", "셀 수", "확보 셀", "확보율(%)"];
  const rows: Cell[][] = [header];
  if (!result) {
    rows.push(["(일조권 검토 미실행)"]);
    return rows;
  }
  for (const s of result.summaries) {
    for (const [label, f] of [
      ["벽면", s.wall],
      ["지붕", s.roof],
    ] as const) {
      if (f.totalCells === 0) continue;
      rows.push([
        s.name,
        label,
        f.totalCells,
        f.passCells,
        round((f.passCells / f.totalCells) * 100, 1),
      ]);
    }
  }
  rows.push([]);
  rows.push(["판정 기준", SUN_HOURS_RULE_LABEL[result.rule]]);
  rows.push(["시간 간격(분)", result.timeStep]);
  return rows;
}

// ---------- 시트 3: 정북사선 결과 ----------

/** 건축법 시행령 제86조 제1항 정북사선 — 계획주동별 정북 방향 이격거리·허용높이 판정 */
export function buildNorthSetbackRows(result: NorthSetbackResult | null): Cell[][] {
  const header: Cell[] = [
    "건물명",
    "정북 방향 이격거리 D(m)",
    "기준선",
    "허용높이(m)",
    "실제높이(m)",
    "판정",
  ];
  const rows: Cell[][] = [header];
  if (!result) {
    rows.push(["(정북사선 검토 미실행)"]);
    return rows;
  }
  for (const c of result.checks) {
    rows.push([
      c.buildingName,
      c.distance !== null ? round(c.distance, 2) : null,
      c.source === "ADJ_BOUNDARY"
        ? "인접대지경계선"
        : c.source === "SITE_BOUNDARY"
          ? "대지경계선(대체)"
          : "미검출",
      c.allowedHeight !== null ? round(c.allowedHeight, 2) : null,
      round(c.actualHeight, 2),
      c.pass ? "적합" : "위반",
    ]);
  }
  return rows;
}

// ---------- 시트 4: PV 결과 (M4 상대 + M5 절대) ----------

/**
 * M4(상대효율)와 M5(연간 kWh/m²) 결과를 건물·면 기준으로 병합.
 * 한쪽만 실행됐으면 해당 컬럼만 채우고 나머지는 빈 칸.
 */
export function buildPvRows(
  result: PvResult | null,
  energy: PvEnergyResult | null = null,
): Cell[][] {
  const header: Cell[] = [
    "건물명",
    "면",
    "셀 수",
    "면적(㎡)",
    "평균효율(%)",
    "최대효율(%)",
    "상위 면적(㎡)",
    "평균 kWh/㎡·년",
    "최대 kWh/㎡·년",
  ];
  const rows: Cell[][] = [header];
  if (!result && !energy) {
    rows.push(["(PV 분석 미실행)"]);
    return rows;
  }

  // M5 면별 kWh 조회 맵 (건물 id + 면 라벨)
  const kwhByFace = new Map<string, { mean: number; max: number }>();
  if (energy) {
    for (const s of energy.summaries) {
      for (const f of s.faces) {
        kwhByFace.set(`${s.buildingId}|${f.face}`, {
          mean: f.meanKwh,
          max: f.maxKwh,
        });
      }
    }
  }

  const seen = new Set<string>();
  if (result) {
    for (const s of result.summaries) {
      for (const f of s.faces) {
        const key = `${s.buildingId}|${f.face}`;
        seen.add(key);
        const kwh = kwhByFace.get(key);
        rows.push([
          s.name,
          f.face,
          f.cellCount,
          round(f.areaM2),
          round(f.meanScorePct),
          round(f.maxScorePct),
          round(f.topAreaM2),
          kwh ? round(kwh.mean) : null,
          kwh ? round(kwh.max) : null,
        ]);
      }
    }
  }
  // M5만 있는 (건물, 면) — 격자 설정이 다르거나 M4 미실행인 경우
  if (energy) {
    for (const s of energy.summaries) {
      for (const f of s.faces) {
        if (seen.has(`${s.buildingId}|${f.face}`)) continue;
        rows.push([
          s.name,
          f.face,
          f.cellCount,
          round(f.areaM2),
          null,
          null,
          null,
          round(f.meanKwh),
          round(f.maxKwh),
        ]);
      }
    }
  }
  if (energy) {
    rows.push([]);
    rows.push([
      "기상데이터",
      `${energy.epwLabel} (${energy.station.name}, TMY 8760시간)`,
    ]);
  }
  return rows;
}

// ---------- 시트 5: 바람길 분석 (M8) ----------

/** M8 — 주풍향·평균풍속·바람그림자 면적 (2D 포텐셜 흐름 근사, CFD 아님) */
export function buildWindRows(result: WindResult | null): Cell[][] {
  const header: Cell[] = ["항목", "값"];
  const rows: Cell[][] = [header];
  if (!result) {
    rows.push(["(바람길 분석 미실행)"]);
    return rows;
  }
  rows.push(["기간", result.month === null ? "연간" : `${result.month}월`]);
  rows.push(["주풍향(도, 0=북)", round(result.windDir, 1)]);
  rows.push(["주풍향(방위)", windDirLabel(result.windDir)]);
  rows.push(["평균 풍속(m/s)", round(result.windSpeedMs, 2)]);
  rows.push(["바람그림자 면적(㎡, 주풍속 0.3배 미만)", round(result.shadowAreaM2, 0)]);
  rows.push(["스트림라인 수", result.streamlines.length]);
  rows.push([]);
  rows.push(["비고", "2D 포텐셜 흐름 근사(개략 검토) — CFD 아님"]);
  return rows;
}

// ---------- 시트 6: 일조시간 지도 (M9) ----------

/** M9 — 기준일별 지면·표면 일조시간 통계와 법적기준(연속2h/총4h) 참고 판정 */
export function buildSunHoursMapRows(result: SunHoursMapResult | null): Cell[][] {
  const header: Cell[] = ["항목", "값"];
  const rows: Cell[][] = [header];
  if (!result) {
    rows.push(["(일조시간 분석 미실행)"]);
    return rows;
  }
  const n = result.cells.length;
  const cont = result.legalCheck.continuous2h;
  const tot = result.legalCheck.total4h;
  rows.push(["기준일", `${result.date} (${result.dates.join(", ")})`]);
  rows.push(["셀 수(지면/건물)", n]);
  rows.push([
    "지면 평균(h)",
    result.groundAvg !== null ? round(result.groundAvg, 2) : "지면 셀 없음",
  ]);
  rows.push(["전체 평균(h)", round(result.stats.avg, 2)]);
  rows.push(["최소(h)", round(result.stats.min, 2)]);
  rows.push(["최대(h)", round(result.stats.max, 2)]);
  rows.push([]);
  rows.push(["법적기준 판정일", result.legalDate]);
  rows.push(["연속2h(9~15시) 통과 셀", cont.pass]);
  rows.push(["연속2h 통과율(%)", n > 0 ? round((cont.pass / n) * 100, 1) : 0]);
  rows.push(["총4h(8~16시) 통과 셀", tot.pass]);
  rows.push(["총4h 통과율(%)", n > 0 ? round((tot.pass / n) * 100, 1) : 0]);
  rows.push([]);
  rows.push([
    "비고",
    "시각화 참고용 — 인접건물 수인한도 판정은 '일조권 검토 결과' 시트가 기준",
  ]);
  return rows;
}

// ---------- 워크북 조립 ----------

export function buildWorkbook(
  project: Project,
  sunHours: SunHoursResult | null,
  northSetback: NorthSetbackResult | null,
  pv: PvResult | null,
  pvEnergy: PvEnergyResult | null = null,
  wind: WindResult | null = null,
  sunHoursMap: SunHoursMapResult | null = null,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const overview = buildOverviewRows(project);
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(
      overview,
      [0],
      [16, 9, 9, 8, 6, 7, 6, 9, 12, 10, 9, 9, 9, 12, 12, 10, 10],
    ),
    "배치 개요",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(buildSunHoursRows(sunHours), [0], [16, 8, 8, 8, 10]),
    "일조권 검토 결과",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(buildNorthSetbackRows(northSetback), [0], [16, 18, 16, 12, 12, 8]),
    "정북사선 결과",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(
      buildPvRows(pv, pvEnergy),
      [0],
      [16, 12, 8, 10, 11, 11, 12, 13, 13],
    ),
    "PV 결과",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(buildWindRows(wind), [0], [34, 28]),
    "바람길분석",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows(buildSunHoursMapRows(sunHoursMap), [0], [24, 34]),
    "일조시간",
  );
  return wb;
}

/** 브라우저 다운로드 */
export function exportXlsx(
  project: Project,
  sunHours: SunHoursResult | null,
  northSetback: NorthSetbackResult | null,
  pv: PvResult | null,
  pvEnergy: PvEnergyResult | null = null,
  wind: WindResult | null = null,
  sunHoursMap: SunHoursMapResult | null = null,
): string {
  const wb = buildWorkbook(project, sunHours, northSetback, pv, pvEnergy, wind, sunHoursMap);
  const filename = `arch_view_배치검토_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
  return filename;
}
