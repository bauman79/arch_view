import type { AreaTableRow } from "./types";

/**
 * 건축개요 엑셀의 "아파트 분양면적표"에서 평형별 전용·주거공용(공급 − 전용)을 읽는다.
 * 표 머리글 행에 "TYPE"(또는 "타입")·"전용면적"·"공급면적"이 함께 있는 표를 찾고, 그 아래 행 중
 * 첫 칸이 숫자인 행을 평형으로 읽다가 "합계"에서 멈춘다. 세대수가 0인 평형도 면적은 읽는다.
 * 함께 찾는 값 (있으면):
 *  - 부대복리시설: 머리글 바로 아래 줄의 "부대복리시설" 열 합계 ÷ 세대수 합계 → 세대당 ㎡
 *  - 근생: 시트의 "용적률산정연면적" − 공급면적 합계 − 부대복리 합계 (양수일 때)
 */
export interface AreaTableImport {
  rows: AreaTableRow[];
  /** 면적표상 세대수 합계 */
  units?: number;
  amenityPerUnit?: number;
  retailM2?: number;
  /** 면적표 용적률 산정 연면적 (비교용) */
  farGfaM2?: number;
  /** 계획대지 면적 (용적률 산정 기준 대지) */
  siteAreaM2?: number;
}

const txt = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function parseAreaTableSheet(sheet: unknown[][]): AreaTableImport | null {
  for (let h = 0; h < sheet.length; h++) {
    const row = sheet[h] ?? [];
    const cType = row.findIndex((v) => /^(TYPE|타입)$/i.test(txt(v)));
    const cEx = row.findIndex((v) => txt(v) === "전용면적");
    const cSup = row.findIndex((v) => txt(v) === "공급면적");
    if (cType < 0 || cEx < 0 || cSup < 0) continue;
    const cUnits = row.findIndex((v) => txt(v) === "세대수");
    const sub = sheet[h + 1] ?? [];
    const cAmen = sub.findIndex((v) => txt(v) === "부대복리시설");
    const rows: AreaTableRow[] = [];
    let supTotal = 0, amenTotal = 0, units = 0;
    for (let r = h + 1; r < sheet.length; r++) {
      const line = sheet[r] ?? [];
      const head = txt(line[cType]);
      if (head === "합계") break;
      const t = num(line[cType]);
      const ex = num(line[cEx]);
      const sup = num(line[cSup]);
      if (t === null || ex === null || sup === null || ex <= 0 || sup < ex) continue;
      rows.push({ type: t, exclusiveM2: round2(ex), commonM2: round2(sup - ex) });
      const n = cUnits >= 0 ? num(line[cUnits]) ?? 0 : 0;
      units += n;
      supTotal += sup * n;
      if (cAmen >= 0) amenTotal += (num(line[cAmen]) ?? 0) * n;
    }
    if (!rows.length) continue;
    const out: AreaTableImport = { rows };
    if (units > 0) {
      out.units = units;
      if (amenTotal > 0) out.amenityPerUnit = round2(amenTotal / units);
    }
    // 용적률산정연면적 (시트 어디든 — 그 줄 첫 숫자)
    for (const line of sheet) {
      const k = (line ?? []).findIndex((v) => txt(v) === "용적률산정연면적");
      if (k < 0) continue;
      const v = (line ?? []).slice(k + 1).map(num).find((x) => x !== null && x > 0);
      if (v) {
        out.farGfaM2 = v;
        const retail = v - supTotal - amenTotal;
        if (units > 0 && retail > 0.5) out.retailM2 = Math.round(retail);
      }
      break;
    }
    for (const line of sheet) {
      const k = (line ?? []).findIndex((v) => txt(v) === "계획대지");
      if (k < 0) continue;
      const v = (line ?? []).slice(k + 1).map(num).find((x) => x !== null && x > 100);
      if (v) out.siteAreaM2 = round2(v);
      break;
    }
    return out;
  }
  return null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
