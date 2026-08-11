import { signedArea } from "./geom2d";
import type { Point2 } from "./types";

/**
 * 맞닿은 폴리곤들의 합집합 — 세대 유니트·코어가 따로 그려진 동평면을 주동 한 동으로 묶는다.
 *
 * 배경: arch_view는 "건물 1동 = 닫힌 폴리곤 1개"를 전제하지만, 실무 동평면은 유니트와
 * 코어를 각각 닫힌 폴리라인으로 그리고 벽을 맞대어 동을 구성하는 경우가 많다.
 * 그대로 읽으면 한 동이 유니트 수만큼의 별개 동으로 쪼개진다.
 *
 * ⚠️ 같은 레이어의 폴리곤을 무조건 합치면 안 된다 — "같은 레이어에 떨어진 폴리곤 여러 개"는
 * 같은 타입 주동을 여러 동 배치한다는 기존 규약이기 때문. 그래서 판별 기준은 레이어가 아니라
 * **엣지 공유**다: 벽을 맞댄 폴리곤만 합치고, 떨어져 있으면 각각 별개 동으로 남긴다.
 *
 * 일반적인 폴리곤 클리핑(선분 교차·부분 겹침)은 하지 않는다. 벽체선이 정점을 공유하도록
 * 그려진 도면만 대상으로 하고, 그렇지 않으면 합치지 않고 원본을 그대로 돌려준다 —
 * 잘못 합쳐 엉뚱한 외곽선을 만드는 것보다 쪼개진 채로 두고 경고하는 편이 안전하다.
 */

/** 정점 일치로 볼 기본 허용오차(m). 도면 좌표는 m로 환산된 뒤 들어온다 */
export const DEFAULT_WELD_TOL_M = 0.002; // 2mm

export interface PolyUnionResult {
  /** 합집합 결과 폴리곤 (합칠 것이 없으면 입력과 동일한 내용) */
  polygons: Point2[][];
  /** polygons[i]가 입력의 어느 폴리곤들에서 나왔는지 (인덱스 목록) */
  sources: number[][];
  /** 맞닿아 있었지만 외곽선을 만들지 못해 원본을 유지한 경우의 사유 */
  failures: string[];
}

/**
 * 정점 용접기 — 허용오차 안의 점들을 하나의 대표 정점으로 묶어 id를 준다.
 *
 * 좌표를 격자에 반올림하는 방식(round(x/tol))은 두 점이 tol보다 가까워도 격자 경계를
 * 사이에 두면 다른 칸으로 갈라진다(예: 10.000과 10.001). 그래서 tol 크기 셀에
 * 담아 두고 이웃 9칸에서 실제 거리로 후보를 찾는 방식을 쓴다.
 */
class VertexWelder {
  private cells = new Map<string, { p: Point2; id: number }[]>();
  private next = 0;
  constructor(private tol: number) {}

  id(p: Point2): number {
    const cx = Math.floor(p.x / this.tol);
    const cy = Math.floor(p.y / this.tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const e of bucket) {
          if (Math.hypot(e.p.x - p.x, e.p.y - p.y) <= this.tol) return e.id;
        }
      }
    }
    const id = this.next++;
    const key = `${cx},${cy}`;
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ p, id });
    else this.cells.set(key, [{ p, id }]);
    return id;
  }
}

/** 방향을 무시한 엣지 키 (양 끝 정점 id를 정렬) */
function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * T자 접합 처리 — 다른 폴리곤의 정점이 어떤 엣지 '중간'에 얹혀 있으면 그 지점에서 엣지를 쪼갠다.
 *
 * 코어가 유니트의 긴 벽 중간에 붙는 배치가 흔한데, 이때 유니트 쪽은 벽 전체가 엣지 하나이고
 * 코어 쪽은 그 일부만 엣지라서 두 엣지가 "같은 엣지"로 인식되지 않는다. 그 결과 맞댄 벽이
 * 외곽으로 잘못 남아 외곽선이 여러 링으로 갈라진다. 쪼개 두면 정확히 공유로 잡힌다.
 */
function splitEdgesAtVertices(
  polys: Point2[][],
  tol: number,
): Point2[][] {
  // 모든 정점을 셀에 담아 엣지 주변만 조회한다 (전수 비교는 도면이 커지면 급격히 느려진다)
  const cells = new Map<string, Point2[]>();
  const cellKey = (x: number, y: number): string =>
    `${Math.floor(x / tol)},${Math.floor(y / tol)}`;
  for (const poly of polys) {
    for (const p of poly) {
      const k = cellKey(p.x, p.y);
      const b = cells.get(k);
      if (b) b.push(p);
      else cells.set(k, [p]);
    }
  }

  const near = (a: Point2, b: Point2): Point2[] => {
    const out: Point2[] = [];
    const x0 = Math.floor(Math.min(a.x, b.x) / tol) - 1;
    const x1 = Math.floor(Math.max(a.x, b.x) / tol) + 1;
    const y0 = Math.floor(Math.min(a.y, b.y) / tol) - 1;
    const y1 = Math.floor(Math.max(a.y, b.y) / tol) + 1;
    // 셀 수가 과도하면(아주 긴 엣지) 전수 조회로 넘어간다 — 정확도 우선
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 40000) return polys.flat();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const b2 = cells.get(`${cx},${cy}`);
        if (b2) out.push(...b2);
      }
    }
    return out;
  };

  return polys.map((poly) => {
    const out: Point2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      out.push(a);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < tol) continue;
      const hits: { t: number; p: Point2 }[] = [];
      for (const p of near(a, b)) {
        // 엣지의 끝점과 같은 점은 대상이 아니다
        if (Math.hypot(p.x - a.x, p.y - a.y) <= tol) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) <= tol) continue;
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
        if (t <= 0 || t >= 1) continue;
        // 엣지에서 수직으로 떨어진 거리
        const perp = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
        if (perp > tol) continue;
        hits.push({ t, p });
      }
      hits.sort((u, v) => u.t - v.t);
      let prev = -1;
      for (const h of hits) {
        if (prev >= 0 && h.t - prev < 1e-9) continue; // 같은 위치 중복 삽입 방지
        out.push(h.p);
        prev = h.t;
      }
    }
    return out;
  });
}

/** 폴리곤을 반시계(CCW)로 정규화 — 공유 엣지가 서로 반대 방향이 되게 만든다 */
function toCcw(poly: Point2[]): Point2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

interface DirectedEdge {
  fromId: number;
  toId: number;
  from: Point2;
  to: Point2;
}

/**
 * 한 그룹(서로 맞닿은 폴리곤들)의 외곽선을 뽑는다.
 * 공유 엣지(두 폴리곤이 맞댄 벽)를 지우고 남은 엣지를 이어 붙인다.
 * @returns 외곽 링. 링이 하나로 떨어지지 않으면 null (구멍·핀치·부분겹침 등)
 */
function outlineOfGroup(polys: Point2[][], welder: VertexWelder): Point2[] | null {
  const undirectedCount = new Map<string, number>();
  const directed: DirectedEdge[] = [];

  for (const poly of polys) {
    const ccw = toCcw(poly);
    for (let i = 0; i < ccw.length; i++) {
      const from = ccw[i];
      const to = ccw[(i + 1) % ccw.length];
      const fi = welder.id(from);
      const ti = welder.id(to);
      if (fi === ti) continue; // 길이 0 엣지 무시
      const ek = edgeKey(fi, ti);
      undirectedCount.set(ek, (undirectedCount.get(ek) ?? 0) + 1);
      directed.push({ fromId: fi, toId: ti, from, to });
    }
  }

  // 한 번만 등장하는 엣지 = 외곽. 두 번이면 맞댄 벽(내부)
  const outer = directed.filter(
    (e) => undirectedCount.get(edgeKey(e.fromId, e.toId)) === 1,
  );
  if (outer.length < 3) return null;

  // 정점마다 나가는 외곽 엣지가 정확히 하나여야 링이 유일하게 결정된다.
  // 둘 이상이면 폴리곤이 한 점에서만 맞닿았거나(핀치) 부분 겹침이라 안전하게 포기한다.
  const outgoing = new Map<number, DirectedEdge>();
  for (const e of outer) {
    if (outgoing.has(e.fromId)) return null;
    outgoing.set(e.fromId, e);
  }

  const start = outer[0];
  const ring: Point2[] = [];
  let cur = start;
  for (let guard = 0; guard <= outer.length; guard++) {
    ring.push(cur.from);
    const next = outgoing.get(cur.toId);
    if (!next) return null; // 열린 사슬 — 외곽선이 닫히지 않는다
    if (next === start) {
      // 외곽 엣지를 전부 소비했을 때만 유효 (남으면 링이 둘 이상 = 구멍/분리)
      return ring.length === outer.length ? ring : null;
    }
    cur = next;
  }
  return null;
}

/**
 * 엣지를 공유하는 폴리곤끼리 합친다.
 * @param polys 닫힌 폴리곤 목록 (마지막 점 = 첫 점 중복 없음, 단위 m)
 * @param tol 정점 일치 허용오차(m)
 */
export function unionAdjacentPolygons(
  polys: Point2[][],
  tol: number = DEFAULT_WELD_TOL_M,
): PolyUnionResult {
  const n = polys.length;
  const failures: string[] = [];
  if (n <= 1) {
    return { polygons: polys, sources: polys.map((_, i) => [i]), failures };
  }

  // 모든 폴리곤이 같은 용접기를 공유해야 정점 동일성 판정이 일관된다
  const welder = new VertexWelder(tol);
  // T자 접합을 먼저 풀어야 맞댄 벽이 공유 엣지로 잡힌다
  const split = splitEdgesAtVertices(polys, tol);

  // 엣지 키 → 그 엣지를 가진 폴리곤 인덱스들
  const owners = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < split[i].length; v++) {
      const a = welder.id(split[i][v]);
      const b = welder.id(split[i][(v + 1) % split[i].length]);
      if (a === b) continue;
      const ek = edgeKey(a, b);
      const list = owners.get(ek);
      if (list) {
        if (!list.includes(i)) list.push(i);
      } else {
        owners.set(ek, [i]);
      }
    }
  }

  const uf = new UnionFind(n);
  for (const list of owners.values()) {
    for (let k = 1; k < list.length; k++) uf.union(list[0], list[k]);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const polygons: Point2[][] = [];
  const sources: number[][] = [];
  // 입력 순서를 최대한 보존 — 그룹의 첫 멤버 인덱스 순으로 내보낸다
  const ordered = [...groups.values()].sort((a, b) => a[0] - b[0]);
  for (const members of ordered) {
    if (members.length === 1) {
      polygons.push(polys[members[0]]);
      sources.push(members);
      continue;
    }
    const outline = outlineOfGroup(
      members.map((i) => split[i]),
      welder,
    );
    if (outline) {
      polygons.push(outline);
      sources.push(members);
    } else {
      // 합치지 못했으면 원본을 그대로 살려 둔다 (형상을 잃지 않는 쪽이 안전)
      failures.push(
        `폴리곤 ${members.length}개가 맞닿아 있지만 하나의 외곽선으로 잇지 못했습니다` +
          ` (중정·부분겹침·한 점 접촉 등) — 합치지 않고 각각 불러왔습니다`,
      );
      for (const i of members) {
        polygons.push(polys[i]);
        sources.push([i]);
      }
    }
  }
  return { polygons, sources, failures };
}
