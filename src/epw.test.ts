import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EPW_FILES, EPW_HOURS_PER_YEAR, parseEpw, type EpwData } from "./epw";
import { sunPosition } from "./sun";

/**
 * M5 EPW 파싱 검증 (plan.md 7장 M5 + M5 요구사항 검증 1).
 * 실제 인천 IWEC 파일로:
 * 1. 헤더 8행 스킵 후 8,760행 파싱, LOCATION의 위도·경도·시간대
 * 2. 1월 1일 12시 DNI 원본 값(710 W/m²) 일치 — 컬럼 인덱스 검증
 * 3. 물리 일관성: GHI ≈ DNI×sin(고도) + DHI (컬럼이 한 칸이라도 밀리면 깨짐)
 */

function readEpw(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../data/${file}`, import.meta.url)),
    "utf-8",
  );
}

let inchon: EpwData;

beforeAll(() => {
  inchon = parseEpw(readEpw("KOR_Inchon.471120_IWEC.epw"));
});

describe("EPW 파싱 — 인천 IWEC", () => {
  it("8,760행과 LOCATION(위도 37.48, 경도 126.55, UTC+9)을 읽는다", () => {
    expect(inchon.hours.length).toBe(EPW_HOURS_PER_YEAR);
    expect(inchon.location.latitude).toBeCloseTo(37.48, 2);
    expect(inchon.location.longitude).toBeCloseTo(126.55, 2);
    expect(inchon.location.timezone).toBe(9);
  });

  it("검증 1 — 1월 1일 12시 DNI=710, DHI=100, GHI=427 (원본 파일 값)", () => {
    const h = inchon.hours.find(
      (r) => r.month === 1 && r.day === 1 && r.hour === 12,
    )!;
    expect(h.dni).toBe(710);
    expect(h.dhi).toBe(100);
    expect(h.ghi).toBe(427);
  });

  it("야간(1월 1일 1시)은 일사 0", () => {
    const h = inchon.hours[0];
    expect([h.month, h.day, h.hour]).toEqual([1, 1, 1]);
    expect(h.ghi).toBe(0);
    expect(h.dni).toBe(0);
    expect(h.dhi).toBe(0);
  });

  it("연간 GHI ≈ 1,176 kWh/m² (인천 IWEC 원본 합계)", () => {
    expect(inchon.annual.ghiKwh).toBeCloseTo(1176, -1);
    expect(inchon.annual.dhiKwh).toBeGreaterThan(0);
    expect(inchon.annual.dniKwh).toBeGreaterThan(0);
  });

  it("물리 일관성 — 주간 시각의 GHI ≈ DNI×sin(고도)+DHI (±25%)", () => {
    // 컬럼 인덱스가 한 칸이라도 밀리면(예: 13을 DNI로 오인) 크게 깨진다
    let checked = 0;
    for (const h of inchon.hours) {
      if (h.ghi < 200) continue; // 저일사 시각은 상대 오차가 커서 제외
      const date = new Date(
        Date.UTC(2026, h.month - 1, h.day, -9, h.hour * 60 - 30),
      );
      const pos = sunPosition(date, 37.48, 126.55);
      if (!pos.dir || pos.altitudeDeg < 10) continue;
      const est = h.dni * pos.dir.y + h.dhi; // dir.y = sin(고도)
      expect(est).toBeGreaterThan(h.ghi * 0.75);
      expect(est).toBeLessThan(h.ghi * 1.25);
      checked++;
      if (checked >= 200) break;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("나머지 3개 지역 파일도 8,760행으로 파싱된다", () => {
    for (const { file } of EPW_FILES) {
      if (file.includes("Inchon")) continue;
      const epw = parseEpw(readEpw(file));
      expect(epw.hours.length).toBe(EPW_HOURS_PER_YEAR);
      expect(epw.location.timezone).toBe(9);
      expect(epw.annual.ghiKwh).toBeGreaterThan(800);
    }
  });

  it("EPW가 아닌 텍스트는 오류", () => {
    expect(() => parseEpw("hello,world\n1,2,3")).toThrow(/LOCATION/);
  });
});
