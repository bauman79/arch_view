import * as THREE from "three";
import SunCalc from "suncalc";

/**
 * 태양 위치 모듈 (M2).
 * suncalc의 고도·방위각을 계산 즉시 3D 단위벡터로 변환한다.
 * ⚠️ 이후 모든 판정(내적·레이캐스팅)은 벡터만 사용 — 각도 스칼라의
 * 비교·보간을 금지한다(방위각 wrap-around 버그 회피, plan.md 2장).
 *
 * 검증 완료: 서울(37.57N) 동지 남중(12:30 KST) 고도 29.00°, 방위각 179.97°.
 */

const UP = new THREE.Vector3(0, 1, 0);

/** 시각 계산에 쓰는 고정 UTC 오프셋(KST). 머신 타임존과 무관하게 동작 */
export const UTC_OFFSET_HOURS = 9;

export interface SunPosition {
  /** 지점→태양 방향 단위벡터 (three 좌표: x=동, y=상, z=남). 고도 ≤ 0이면 null */
  dir: THREE.Vector3 | null;
  /** 고도(도) — UI 표시 전용, 판정 로직 사용 금지 */
  altitudeDeg: number;
  /** 방위각(도, 북=0 시계방향) — UI 표시 전용, 판정 로직 사용 금지 */
  azimuthDeg: number;
}

/** "YYYY-MM-DD" + 자정 기준 분(현지시각) → Date */
export function localDate(dateStr: string, minutes: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, -UTC_OFFSET_HOURS, minutes));
}

/**
 * 태양 방향 단위벡터 계산.
 * suncalc 방위각 규약: 남=0, 서쪽으로 +(라디안).
 * ENU 분해: E=-sin(az)·cos(h), N=-cos(az)·cos(h), U=sin(h)
 * three 매핑: x=E, y=U, z=-N
 * @param northAngleDeg 도면 Y+ 기준 정북 보정 각도(반시계, 도)
 */
export function sunPosition(
  date: Date,
  lat: number,
  lng: number,
  northAngleDeg = 0,
): SunPosition {
  const p = SunCalc.getPosition(date, lat, lng);
  const altitudeDeg = THREE.MathUtils.radToDeg(p.altitude);
  const azimuthDeg =
    (((THREE.MathUtils.radToDeg(p.azimuth) + 180) % 360) + 360) % 360;
  if (p.altitude <= 0) return { dir: null, altitudeDeg, azimuthDeg };

  const cosH = Math.cos(p.altitude);
  const dir = new THREE.Vector3(
    -Math.sin(p.azimuth) * cosH, // 동(+x)
    Math.sin(p.altitude), // 상(+y)
    Math.cos(p.azimuth) * cosH, // 남(+z)
  );
  if (northAngleDeg !== 0) {
    dir.applyAxisAngle(UP, THREE.MathUtils.degToRad(northAngleDeg));
  }
  return { dir: dir.normalize(), altitudeDeg, azimuthDeg };
}

export interface SunSample extends SunPosition {
  /** 자정 기준 분 (현지시각) */
  minutes: number;
  /** "HH:MM" */
  label: string;
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** [startMin, endMin] 구간을 stepMin 간격으로 샘플링한 태양 위치 목록 */
export function sunSamples(
  dateStr: string,
  lat: number,
  lng: number,
  northAngleDeg: number,
  startMin: number,
  endMin: number,
  stepMin: number,
): SunSample[] {
  const samples: SunSample[] = [];
  for (let m = startMin; m <= endMin; m += stepMin) {
    const pos = sunPosition(localDate(dateStr, m), lat, lng, northAngleDeg);
    samples.push({ ...pos, minutes: m, label: formatMinutes(m) });
  }
  return samples;
}
