/**
 * 배치안(scheme) 저장·비교 — 여러 대안을 슬롯에 담아 지표를 나란히 놓고 고른다.
 *
 * 지금까지는 한 세션에서 배치 하나만 편집할 수 있어, 대안을 견주려면 .view 파일을
 * 여러 개 저장해 두고 번갈아 불러와야 했다. 배치안은 브라우저 localStorage에
 * 저장하며, 본문은 기존 .view 직렬화(serializeView)를 그대로 재사용하므로
 * 저장/복원 규칙이 파일 저장과 갈라지지 않는다.
 *
 * localStorage는 오리진당 5MB 안팎이라 슬롯 수를 제한하고, 초과 기록은
 * 저장 시점에 사용자에게 알린다. 영구 보관은 여전히 .view 파일 저장이 정답.
 */

const STORAGE_KEY = "arch_view.schemes.v1";

/** 슬롯 상한 — 넘으면 저장 대신 안내한다 (localStorage 용량 보호) */
export const MAX_SCHEMES = 8;

/** 검토 항목 하나의 집계 (적합/전체). 미검토면 null */
export interface CheckTally {
  pass: number;
  total: number;
}

/** 비교표에 쓰는 지표 — 배치안 저장 시점에 계산해 함께 굳혀 둔다 */
export interface SchemeMetrics {
  /** 계획주동 동수 */
  planCount: number;
  totalUnits: number;
  /** 평형별 세대수 (표시 순서 보존) */
  byType: { unitType: string; count: number }[];
  coverageM2: number;
  grossM2: number;
  /** 대지면적 미입력이면 null */
  bcrPct: number | null;
  farPct: number | null;
  /** 미검토 상태면 null — "0/0 적합"과 "아직 안 돌림"을 구분하기 위함 */
  north: CheckTally | null;
  daylight: CheckTally | null;
  spacing: CheckTally | null;
}

export interface SchemeRecord {
  id: string;
  name: string;
  /** ISO 8601 */
  savedAt: string;
  metrics: SchemeMetrics;
  /** serializeView() 결과 JSON 문자열 — 불러오기는 deserializeView로 처리 */
  view: string;
}

function storage(): Storage | null {
  try {
    // 사파리 프라이빗 모드 등에서 접근 자체가 throw 할 수 있다
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 저장된 배치안 목록 (최근 저장이 앞) — 손상된 레코드는 걸러낸다 */
export function listSchemes(): SchemeRecord[] {
  const s = storage();
  if (!s) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(s.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return (raw as SchemeRecord[]).filter(
    (r) =>
      r &&
      typeof r.id === "string" &&
      typeof r.name === "string" &&
      typeof r.view === "string" &&
      !!r.metrics,
  );
}

function writeAll(list: SchemeRecord[]): void {
  const s = storage();
  if (!s) throw new Error("이 브라우저에서는 로컬 저장을 쓸 수 없습니다");
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // QuotaExceededError — 용량이 찼다
    throw new Error(
      "브라우저 저장 공간이 부족합니다 — 배치안을 삭제하거나 .view 파일로 저장하세요",
    );
  }
}

/**
 * 배치안 저장. 같은 이름이 있으면 덮어쓴다(슬롯 낭비 방지).
 * @returns 저장된 레코드
 */
export function saveScheme(
  name: string,
  metrics: SchemeMetrics,
  view: string,
): SchemeRecord {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("배치안 이름을 입력하세요");
  const list = listSchemes();
  const existing = list.findIndex((r) => r.name === trimmed);
  if (existing < 0 && list.length >= MAX_SCHEMES) {
    throw new Error(
      `배치안은 최대 ${MAX_SCHEMES}개까지 저장됩니다 — 기존 안을 삭제하세요`,
    );
  }
  const rec: SchemeRecord = {
    id: existing >= 0 ? list[existing].id : `scheme_${Date.now().toString(36)}`,
    name: trimmed,
    savedAt: new Date().toISOString(),
    metrics,
    view,
  };
  if (existing >= 0) list.splice(existing, 1);
  list.unshift(rec);
  writeAll(list);
  return rec;
}

export function deleteScheme(id: string): void {
  writeAll(listSchemes().filter((r) => r.id !== id));
}

export function getScheme(id: string): SchemeRecord | null {
  return listSchemes().find((r) => r.id === id) ?? null;
}

/** 저장 시각을 "8/10 14:32" 형태로 */
export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** 검토 집계를 "3/3 적합" / "1/3 위반" / "미검토"로 */
export function tallyLabel(t: CheckTally | null): string {
  if (!t || t.total === 0) return "미검토";
  return t.pass === t.total ? `${t.pass}/${t.total} 적합` : `${t.pass}/${t.total} 위반`;
}

/** 비교표에서 값이 가장 좋은 배치안을 강조하기 위한 최댓값 (동률이면 모두 강조) */
export function maxOf(
  list: SchemeRecord[],
  pick: (m: SchemeMetrics) => number | null,
): number | null {
  let best: number | null = null;
  for (const r of list) {
    const v = pick(r.metrics);
    if (v === null) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}
