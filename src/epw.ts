/**
 * M5 — EPW(TMY) 기상데이터 파싱 (plan.md 모드 B 2단계).
 * EPW는 CSV 형태: 헤더 8행(LOCATION, DESIGN CONDITIONS, …, DATA PERIODS) 뒤
 * 8,760행의 시간별 데이터. 시각 컬럼의 hour는 1~24로, 그 시각에 "끝나는"
 * 1시간 구간의 평균값이다(예: hour=12 → 11:00~12:00) — 태양 위치는
 * 구간 중앙(hour−0.5)에서 계산한다.
 *
 * ⚠️ 일사 컬럼 인덱스(0-indexed): 13=GHI(수평전일사), 14=DNI(직달), 15=DHI(산란).
 * 실제 IWEC 파일로 검증: 인천 1월 1일 12시 GHI=427, DNI=710, DHI=100
 * → DNI×sin(고도 29.5°)+DHI ≈ 448 ≈ GHI. (11번째는 대기외 직달 — 혼동 주의)
 */

/** data/ 폴더의 EPW 파일 목록 — public/data/에 복사되어 fetch로 접근 */
export const EPW_FILES = [
  { file: "KOR_Inchon.471120_IWEC.epw", label: "인천" },
  { file: "KOR_Kangnung.471050_IWEC.epw", label: "강릉" },
  { file: "KOR_Ulsan.471520_IWEC.epw", label: "울산" },
  { file: "KOR_Kwangju.471560_IWEC.epw", label: "광주" },
] as const;

export const EPW_HEADER_LINES = 8;
export const EPW_HOURS_PER_YEAR = 8760;

/** 일사 컬럼 인덱스 (0-indexed) */
const COL_MONTH = 1;
const COL_DAY = 2;
const COL_HOUR = 3;
const COL_GHI = 13;
const COL_DNI = 14;
const COL_DHI = 15;
/** EPW 결측 표기 (일사는 9999) — 0으로 취급 */
const MISSING = 9999;

export interface EpwLocation {
  name: string;
  latitude: number;
  longitude: number;
  /** UTC 오프셋 (시간, 한국 = 9) */
  timezone: number;
}

export interface EpwHour {
  month: number;
  day: number;
  /** 1~24 — 그 시각에 끝나는 1시간 구간 */
  hour: number;
  /** 수평전일사 (W/m²) — 검증용 */
  ghi: number;
  /** 직달일사 (W/m², 법선면 기준) */
  dni: number;
  /** 산란일사 (W/m², 수평면 기준) */
  dhi: number;
}

export interface EpwData {
  location: EpwLocation;
  hours: EpwHour[];
  /** 연간 합계 (kWh/m²) — 무차폐 수평면 sanity check용 */
  annual: { ghiKwh: number; dniKwh: number; dhiKwh: number };
}

function radiation(field: string): number {
  const v = parseFloat(field);
  if (!isFinite(v) || v < 0 || v >= MISSING) return 0;
  return v;
}

export function parseEpw(text: string): EpwData {
  const lines = text.split(/\r?\n/);
  if (lines.length < EPW_HEADER_LINES + 1 || !lines[0].startsWith("LOCATION")) {
    throw new Error("EPW 형식이 아닙니다 (LOCATION 헤더 없음)");
  }
  const loc = lines[0].split(",");
  const location: EpwLocation = {
    name: loc[1] ?? "",
    latitude: parseFloat(loc[6]),
    longitude: parseFloat(loc[7]),
    timezone: parseFloat(loc[8]),
  };
  if (!isFinite(location.latitude) || !isFinite(location.longitude)) {
    throw new Error("EPW LOCATION 행의 위도·경도를 읽을 수 없습니다");
  }

  const hours: EpwHour[] = [];
  let ghiSum = 0;
  let dniSum = 0;
  let dhiSum = 0;
  for (let i = EPW_HEADER_LINES; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // 끝의 빈 줄
    const f = line.split(",");
    if (f.length <= COL_DHI) continue;
    const ghi = radiation(f[COL_GHI]);
    const dni = radiation(f[COL_DNI]);
    const dhi = radiation(f[COL_DHI]);
    hours.push({
      month: parseInt(f[COL_MONTH], 10),
      day: parseInt(f[COL_DAY], 10),
      hour: parseInt(f[COL_HOUR], 10),
      ghi,
      dni,
      dhi,
    });
    ghiSum += ghi;
    dniSum += dni;
    dhiSum += dhi;
  }
  if (hours.length !== EPW_HOURS_PER_YEAR) {
    throw new Error(
      `EPW 데이터 행이 ${hours.length}개 — ${EPW_HOURS_PER_YEAR}개(1년 시간별)가 필요합니다`,
    );
  }
  return {
    location,
    hours,
    // W×1h → kWh
    annual: {
      ghiKwh: ghiSum / 1000,
      dniKwh: dniSum / 1000,
      dhiKwh: dhiSum / 1000,
    },
  };
}
