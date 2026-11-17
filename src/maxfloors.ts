import { worldFootprint } from "./buildings";
import { runDaylightCheck } from "./daylight";
import { runNorthSetbackCheck } from "./northsetback";
import { runSpacingCheck } from "./spacing";
import type { Building, Project } from "./types";

/**
 * 법규 최대 층수 자동 찾기 — 계획주동마다 정북사선·채광사선·인동거리를 모두 만족하는
 * 최대 층수를 찾는다. 층수가 늘수록 위반이 늘기만 하므로(단조) 동마다 이분 탐색한다.
 *
 * - 최소 층수에서도 이미 걸려 있는 위반(측벽 4m·창 없는 벽 8m처럼 높이와 무관한 거리 기준,
 *   붙어 있는 동 등)은 층수로 풀 수 없으므로 탐색에서 빼고 "기존 위반"으로 따로 알린다.
 * - 인동거리는 두 동의 높이가 함께 걸리므로, 한 동을 정할 때 다른 동은 현재(또는 앞서 정한)
 *   층수로 두고 전체를 2회 반복해 서로 맞춘다.
 * - 정북·채광은 그 동과 경계선만, 인동은 주변 동만 넣은 축소 프로젝트로 계산해 빠르게.
 * 일조권(인접건물 수인한도)은 레이캐스팅이라 여기서 보지 않는다.
 */

export type LimitRule = "정북사선" | "채광사선" | "인동거리" | "한도";

export interface MaxFloorResult {
  id: string;
  name: string;
  before: number;
  max: number;
  /** 한 층 더 올리면 걸리는 기준 (한도까지 올라가면 "한도") */
  limit: LimitRule;
  /** 층수와 무관하게 이미 걸려 있는 위반 수 */
  fixedViolations: number;
}

/** 계획주동 이름 "계획주동_A_1" → 타입 "A" */
export function planTypeOf(name: string): string {
  const m = name.match(/_([A-Za-z0-9]+)_\d+$/);
  return m ? m[1].toUpperCase() : "기타";
}

const NEAR_M = 150;

function bbox(b: Building) {
  const fp = worldFootprint(b);
  return {
    x0: Math.min(...fp.map((p) => p.x)),
    y0: Math.min(...fp.map((p) => p.y)),
    x1: Math.max(...fp.map((p) => p.x)),
    y1: Math.max(...fp.map((p) => p.y)),
  };
}

/** 이 동이 걸린 위반 목록 (키 + 기준) — 축소 프로젝트로 계산 */
export function violations(project: Project, b: Building, neighbors?: Building[]): Map<string, LimitRule> {
  const out = new Map<string, LimitRule>();
  const solo = { ...project, buildings: [b] };
  const north = runNorthSetbackCheck(solo).checks.find((c) => c.buildingId === b.id);
  if (north && !north.pass) out.set("N", "정북사선");
  for (const c of runDaylightCheck(solo).checks) {
    if (c.buildingId === b.id && !c.pass) out.set(`D:${c.point.x.toFixed(2)},${c.point.y.toFixed(2)}`, "채광사선");
  }
  const near = { ...project, buildings: neighbors ? [b, ...neighbors.filter((x) => x.id !== b.id)] : project.buildings };
  for (const c of runSpacingCheck(near).checks) {
    if ((c.aId === b.id || c.bId === b.id) && !c.pass) {
      const other = c.aId === b.id ? c.bId : c.aId;
      out.set(`S:${other}:${c.rule}:${((c.pa.x + c.pb.x) / 2).toFixed(1)},${((c.pa.y + c.pb.y) / 2).toFixed(1)}`, "인동거리");
    }
  }
  return out;
}

/** 이 동에 걸린 첫 위반 기준 (없으면 null) — 테스트·확인용 */
export function failingRule(project: Project, b: Building): LimitRule | null {
  const v = violations(project, b);
  for (const r of ["정북사선", "채광사선", "인동거리"] as LimitRule[]) if ([...v.values()].includes(r)) return r;
  return null;
}

export async function findMaxFloors(
  project: Project,
  ids: string[],
  cap: number,
  onProgress?: (done: number, total: number) => void,
  yieldFn: () => Promise<void> = () => Promise.resolve(),
): Promise<MaxFloorResult[]> {
  const targets = project.buildings.filter((b) => ids.includes(b.id) && b.type === "계획주동");
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  const boxes = new Map(plans.map((b) => [b.id, bbox(b)]));
  const neighborsOf = (b: Building) => {
    const a = boxes.get(b.id)!;
    return plans.filter((o) => {
      if (o.id === b.id) return false;
      const c = boxes.get(o.id)!;
      const dx = Math.max(0, c.x0 - a.x1, a.x0 - c.x1);
      const dy = Math.max(0, c.y0 - a.y1, a.y0 - c.y1);
      return Math.hypot(dx, dy) < NEAR_M;
    });
  };
  const before = new Map(targets.map((b) => [b.id, b.floors]));
  const limit = new Map<string, LimitRule>();
  const fixed = new Map<string, number>();
  const nbs = new Map(targets.map((b) => [b.id, neighborsOf(b)]));
  const base = new Map<string, Map<string, LimitRule>>();
  // 모두 최소 층수로 내린 뒤 층수와 무관한 기존 위반을 기록
  for (const b of targets) b.floors = Math.max(1, b.pilotiFloors + 1);
  for (const b of targets) {
    const v = violations(project, b, nbs.get(b.id));
    base.set(b.id, v);
    fixed.set(b.id, v.size);
  }
  const newFail = (b: Building): LimitRule | null => {
    const bs = base.get(b.id)!;
    for (const [k, r] of violations(project, b, nbs.get(b.id))) if (!bs.has(k)) return r;
    return null;
  };
  // 한 층씩 돌아가며 올린다 — 이웃끼리 인동거리를 공평하게 나눠 쓰도록(먼저 올린 동이 독차지하지 않게)
  let active = targets.filter((b) => b.floors < cap);
  const maxRounds = cap;
  let round = 0;
  while (active.length && round < maxRounds) {
    round++;
    const next: Building[] = [];
    for (const b of active) {
      // 큰 걸음(+4)으로 먼저, 막히면 한 층씩 — 라운드 수를 줄여 빠르게
      const start = b.floors;
      let ok = false;
      for (const stepUp of [4, 1]) {
        if (start + stepUp > cap) continue;
        b.floors = start + stepUp;
        const f = newFail(b);
        if (!f) {
          ok = true;
          break;
        }
        b.floors = start;
        limit.set(b.id, f);
      }
      if (!ok) continue;
      limit.delete(b.id);
      if (b.floors >= cap) limit.set(b.id, "한도");
      else next.push(b);
    }
    active = next;
    onProgress?.(round, maxRounds);
    await yieldFn();
  }
  return targets.map((b) => ({
    id: b.id,
    name: b.name,
    before: before.get(b.id)!,
    max: b.floors,
    limit: limit.get(b.id) ?? "한도",
    fixedViolations: fixed.get(b.id) ?? 0,
  }));
}
