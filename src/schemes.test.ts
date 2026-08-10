import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteScheme,
  formatSavedAt,
  getScheme,
  listSchemes,
  MAX_SCHEMES,
  maxOf,
  saveScheme,
  tallyLabel,
  type SchemeMetrics,
  type SchemeRecord,
} from "./schemes";

/** vitest 기본 환경(node)에는 localStorage가 없어 최소 구현을 붙인다 */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage);
}

function metrics(overrides: Partial<SchemeMetrics> = {}): SchemeMetrics {
  return {
    planCount: 3,
    totalUnits: 160,
    byType: [{ unitType: "59㎡", count: 80 }],
    coverageM2: 1200,
    grossM2: 18000,
    bcrPct: 20,
    farPct: 300,
    north: { pass: 3, total: 3 },
    daylight: null,
    spacing: null,
    ...overrides,
  };
}

describe("배치안 저장소", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it("저장한 배치안을 다시 읽어온다", () => {
    saveScheme("A안", metrics(), '{"format":"arch_view"}');
    const list = listSchemes();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("A안");
    expect(list[0].metrics.totalUnits).toBe(160);
    expect(list[0].view).toBe('{"format":"arch_view"}');
  });

  it("최근 저장이 앞에 온다", () => {
    saveScheme("A안", metrics(), "{}");
    saveScheme("B안", metrics(), "{}");
    expect(listSchemes().map((r) => r.name)).toEqual(["B안", "A안"]);
  });

  it("같은 이름은 슬롯을 늘리지 않고 덮어쓴다", () => {
    const first = saveScheme("A안", metrics({ totalUnits: 100 }), "{}");
    const second = saveScheme("A안", metrics({ totalUnits: 200 }), "{}");
    const list = listSchemes();
    expect(list).toHaveLength(1);
    expect(list[0].metrics.totalUnits).toBe(200);
    // 덮어쓸 때 id는 유지 — 불러오기 참조가 끊기지 않게
    expect(second.id).toBe(first.id);
  });

  it("이름이 비면 거부한다", () => {
    expect(() => saveScheme("   ", metrics(), "{}")).toThrow(/이름/);
  });

  it("슬롯 상한을 넘기면 저장을 막는다", () => {
    for (let i = 0; i < MAX_SCHEMES; i++) saveScheme(`안${i}`, metrics(), "{}");
    expect(() => saveScheme("초과안", metrics(), "{}")).toThrow(/최대/);
    // 상한에 걸려도 기존 이름 덮어쓰기는 계속 가능해야 한다
    expect(() => saveScheme("안0", metrics(), "{}")).not.toThrow();
    expect(listSchemes()).toHaveLength(MAX_SCHEMES);
  });

  it("삭제하면 목록에서 빠진다", () => {
    const rec = saveScheme("A안", metrics(), "{}");
    deleteScheme(rec.id);
    expect(listSchemes()).toHaveLength(0);
    expect(getScheme(rec.id)).toBeNull();
  });

  it("저장 내용이 깨져 있으면 빈 목록으로 되돌린다", () => {
    localStorage.setItem("arch_view.schemes.v1", "{ not json");
    expect(listSchemes()).toEqual([]);
  });

  it("형태가 어긋난 레코드는 걸러낸다", () => {
    localStorage.setItem(
      "arch_view.schemes.v1",
      JSON.stringify([{ id: "x", name: "정상", view: "{}", metrics: metrics() }, { id: 1 }, null]),
    );
    expect(listSchemes().map((r) => r.name)).toEqual(["정상"]);
  });
});

describe("표시 헬퍼", () => {
  it("tallyLabel — 미검토와 전량 적합을 구분한다", () => {
    expect(tallyLabel(null)).toBe("미검토");
    expect(tallyLabel({ pass: 0, total: 0 })).toBe("미검토");
    expect(tallyLabel({ pass: 3, total: 3 })).toBe("3/3 적합");
    expect(tallyLabel({ pass: 1, total: 3 })).toBe("1/3 위반");
  });

  it("formatSavedAt — 잘못된 값은 빈 문자열", () => {
    expect(formatSavedAt("nope")).toBe("");
    expect(formatSavedAt("2026-08-10T14:32:00")).toMatch(/8\/10 14:32/);
  });

  it("maxOf — null(미입력)은 후보에서 제외한다", () => {
    const list = [
      { metrics: metrics({ totalUnits: 100 }) },
      { metrics: metrics({ totalUnits: 300 }) },
      { metrics: metrics({ bcrPct: null }) },
    ] as SchemeRecord[];
    expect(maxOf(list, (m) => m.totalUnits)).toBe(300);
    expect(maxOf([{ metrics: metrics({ bcrPct: null }) }] as SchemeRecord[], (m) => m.bcrPct)).toBeNull();
  });
});
