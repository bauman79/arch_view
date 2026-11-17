import * as THREE from "three";
import { footprintCentroid, worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule, BoardItem } from "./analyses";
import { disposeObject, numInput, pct } from "./analyses";
import { pointInPolygon } from "./geom2d";
import { gradientFromStops } from "./legend";
import { yieldToEventLoop } from "./pv";
import type { Building, Point2, Project } from "./types";

/**
 * 도로소음 간이 예측 — 도로중심선(ROAD_CL)을 선음원으로 보고 계획주동 외벽의 층별 소음도를
 * 추정한다. 사전 검토용 근사:
 *  - 선음원 세기는 "도로에서 7.5m 떨어진 곳의 소음도 L0"(설정)로 정한다.
 *    무한 직선도로라면 거리 d에서 L0 − 10·log10(d/7.5)가 되도록 구간(10m)별 점음원을 합산.
 *  - 사이에 낀 건물은 회절 감쇠(Maekawa, 500Hz, 최대 20dB)로 처리.
 *  - 지면 흡음·공기 흡음·반사·교통량 차이는 반영하지 않는다.
 * 공동주택 실외 소음 기준(통상 65dB)은 설정값으로 둔다 — 정식 소음 예측(환경영향평가)
 * 결과를 대신하지 않는다.
 */

const LAMBDA = 0.68; // 500Hz 파장 (m)
const SRC_H = 0.5; // 음원 높이 (m)
const SEG_M = 10;

export interface NoisePoint {
  buildingId: string;
  floor: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  db: number;
}

export interface NoiseResult {
  l0: number;
  limit: number;
  points: NoisePoint[];
  buildings: { id: string; name: string; points: number; over: number; max: number; at: THREE.Vector3 }[];
}

interface Seg {
  m: Point2;
  len: number;
}

/** 도로중심선 → 10m 구간 중점 */
export function roadSegments(lines: Point2[][]): Seg[] {
  const out: Seg[] = [];
  for (const pts of lines) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const k = Math.max(1, Math.round(L / SEG_M));
      for (let j = 0; j < k; j++) {
        const s = (j + 0.5) / k;
        out.push({ m: { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s }, len: L / k });
      }
    }
  }
  return out;
}

/** Maekawa 회절 감쇠 (dB) — 경로차 δ */
export function maekawa(delta: number): number {
  if (delta <= 0) return 0;
  const N = (2 * delta) / LAMBDA;
  return Math.min(20, 10 * Math.log10(3 + 20 * N));
}

interface Obst {
  fp: Point2[];
  h: number;
  x0: number; y0: number; x1: number; y1: number;
  id: string;
}

/** 선분과 다각형 변의 교차 매개변수 중 최소 (0~1), 없으면 null */
function firstCross(ax: number, ay: number, bx: number, by: number, fp: Point2[]): number | null {
  let best: number | null = null;
  const dx = bx - ax, dy = by - ay;
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i], q = fp[(i + 1) % fp.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - ax) * ey - (p.y - ay) * ex) / den;
    const u = ((p.x - ax) * dy - (p.y - ay) * dx) / den;
    if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) {
      if (best === null || t < best) best = t;
    }
  }
  return best;
}

/** 외벽 수음점 (2D) — 변마다 step 간격, 바깥 법선 */
export function facadeReceivers(b: Building, step: number): { p: Point2; n: Point2 }[] {
  const fp = worldFootprint(b);
  const out: { p: Point2; n: Point2 }[] = [];
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i], c = fp[(i + 1) % fp.length];
    const L = Math.hypot(c.x - a.x, c.y - a.y);
    if (L < 2) continue;
    let n = { x: (c.y - a.y) / L, y: -(c.x - a.x) / L };
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    if (pointInPolygon(mid.x + n.x * 0.3, mid.y + n.y * 0.3, fp)) n = { x: -n.x, y: -n.y };
    const k = Math.max(1, Math.round(L / step));
    for (let j = 0; j < k; j++) {
      const s = (j + 0.5) / k;
      out.push({ p: { x: a.x + (c.x - a.x) * s + n.x * 0.5, y: a.y + (c.y - a.y) * s + n.y * 0.5 }, n });
    }
  }
  return out;
}

export async function runNoise(
  project: Project,
  opts: { l0: number; limit: number; maxDist: number; step: number },
  onProgress: (pct: number) => void,
): Promise<NoiseResult> {
  const { buildings } = project;
  const plans = buildings.filter((b) => b.type === "계획주동");
  if (plans.length === 0) throw new Error("계획주동이 없습니다");
  const roads = project.siteOverlays.filter((o) => o.layer === "ROAD_CL" && o.points.length >= 2).map((o) => o.points);
  if (roads.length === 0) throw new Error("도로중심선(ROAD_CL)이 없습니다");
  const segs = roadSegments(roads);
  const Wp = 2 * 7.5 * 10 ** (opts.l0 / 10);

  // 장애물 + 격자 색인 (20m)
  const obst: Obst[] = buildings.map((b) => {
    const fp = worldFootprint(b);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of fp) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { fp, h: b.floors * b.floorHeight, x0, y0, x1, y1, id: b.id };
  });
  const CELL = 20;
  const grid = new Map<string, number[]>();
  obst.forEach((o, i) => {
    for (let gx = Math.floor(o.x0 / CELL); gx <= Math.floor(o.x1 / CELL); gx++)
      for (let gy = Math.floor(o.y0 / CELL); gy <= Math.floor(o.y1 / CELL); gy++) {
        const k = `${gx},${gy}`;
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  });
  const candidates = (a: Point2, b: Point2): Set<number> => {
    const set = new Set<number>();
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.ceil(L / (CELL / 2)));
    for (let j = 0; j <= k; j++) {
      const x = a.x + ((b.x - a.x) * j) / k, y = a.y + ((b.y - a.y) * j) / k;
      const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) set.add(i);
    }
    return set;
  };

  const points: NoisePoint[] = [];
  const summaries: NoiseResult["buildings"] = [];
  let done = 0;
  for (const b of plans) {
    const recs = facadeReceivers(b, opts.step);
    const gl = b.terrainElevation ?? 0;
    const from = Math.min(b.floors, Math.max(0, b.pilotiFloors)) + 1;
    const mine: NoisePoint[] = [];
    for (const r of recs) {
      // 구간별 경로 정보 (층과 무관) — 2D 거리, 차단 건물 높이·수음점 쪽 거리
      const paths: { d: number; len: number; bh: number; dr: number }[] = [];
      for (const s of segs) {
        const vx = s.m.x - r.p.x, vy = s.m.y - r.p.y;
        const d = Math.hypot(vx, vy);
        if (d > opts.maxDist || d < 0.5) continue;
        if ((vx * r.n.x + vy * r.n.y) / d < 0.05) continue; // 벽 뒤쪽 도로
        let bh = 0, dr = 0;
        for (const i of candidates(r.p, s.m)) {
          const o = obst[i];
          if (o.h <= bh) continue;
          if (Math.max(r.p.x, s.m.x) < o.x0 || Math.min(r.p.x, s.m.x) > o.x1) continue;
          if (Math.max(r.p.y, s.m.y) < o.y0 || Math.min(r.p.y, s.m.y) > o.y1) continue;
          const t = firstCross(r.p.x, r.p.y, s.m.x, s.m.y, o.fp);
          if (t === null) continue;
          bh = o.h;
          dr = t * d;
        }
        paths.push({ d, len: s.len, bh, dr });
      }
      for (let f = from; f <= b.floors; f++) {
        const z = (f - 1) * b.floorHeight + 1.5; // 지면 기준 상대 높이
        let I = 0;
        for (const p of paths) {
          const dz = z - SRC_H;
          const r3 = Math.hypot(p.d, dz);
          let A = 0;
          if (p.bh > 0) {
            const ds = p.d - p.dr;
            // 시선이 장벽 위를 지나면(장벽이 낮으면) 감쇠 없음
            const losH = z + (SRC_H - z) * (p.dr / p.d);
            if (p.bh > losH) {
              const delta = Math.hypot(p.dr, p.bh - z) + Math.hypot(ds, p.bh - SRC_H) - r3;
              A = maekawa(delta);
            }
          }
          I += ((Wp * p.len) / (2 * Math.PI * r3 * r3)) * 10 ** (-A / 10);
        }
        const db = I > 0 ? 10 * Math.log10(I) : 0;
        mine.push({
          buildingId: b.id,
          floor: f,
          position: new THREE.Vector3(r.p.x, gl + (f - 1) * b.floorHeight + 1.5, -r.p.y),
          normal: new THREE.Vector3(r.n.x, 0, -r.n.y),
          db,
        });
      }
    }
    points.push(...mine);
    if (mine.length) {
      const c = footprintCentroid(worldFootprint(b));
      summaries.push({
        id: b.id,
        name: b.name,
        points: mine.length,
        over: mine.filter((p) => p.db >= opts.limit).length,
        max: Math.max(...mine.map((p) => p.db)),
        at: new THREE.Vector3(c.x, gl + (b.floors * b.floorHeight) / 2, -c.y),
      });
    }
    done++;
    onProgress((done / plans.length) * 100);
    await yieldToEventLoop();
  }
  return { l0: opts.l0, limit: opts.limit, points, buildings: summaries };
}

export const NOISE_STOPS: [number, number][] = [
  [45, 0x22c55e],
  [55, 0x84cc16],
  [60, 0xfacc15],
  [65, 0xf97316],
  [70, 0xef4444],
  [75, 0x7f1d1d],
];

export function noiseColor(db: number, out = new THREE.Color()): THREE.Color {
  if (db <= NOISE_STOPS[0][0]) return out.set(NOISE_STOPS[0][1]);
  for (let i = 1; i < NOISE_STOPS.length; i++) {
    if (db <= NOISE_STOPS[i][0]) {
      const [v0, c0] = NOISE_STOPS[i - 1];
      const [v1, c1] = NOISE_STOPS[i];
      return out.set(c0).lerp(new THREE.Color(c1), (db - v0) / (v1 - v0));
    }
  }
  return out.set(NOISE_STOPS[NOISE_STOPS.length - 1][1]);
}

/** 외벽 측정점 판 (위치·법선·색) — 소음·천공률 공용 */
export function facadePanels(
  items: { position: THREE.Vector3; normal: THREE.Vector3; color: THREE.Color }[],
  name: string,
  w = 1.4,
  h = 1.0,
): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, 0.15), new THREE.MeshBasicMaterial(), Math.max(1, items.length));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const z = new THREE.Vector3(0, 0, 1);
  const one = new THREE.Vector3(1, 1, 1);
  items.forEach((it, i) => {
    q.setFromUnitVectors(z, it.normal);
    m.compose(it.position.clone().addScaledVector(it.normal, 0.2), q, one);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, it.color);
  });
  inst.count = items.length;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.name = name;
  return inst;
}

export function createNoiseModule(ctx: AnalysisContext): AnalysisModule {
  let result: NoiseResult | null = null;
  let overlay: THREE.Object3D | null = null;
  const over = () => result!.points.filter((p) => p.db >= result!.limit).length;
  return {
    id: "noise",
    slot: "env",
    title: "도로소음 간이 예측",
    hint: "도로중심선(ROAD_CL) 선음원 → 계획주동 외벽 층별 소음도 (건물 회절 감쇠 반영, 사전 검토용)",
    settingsHtml: `
      <div class="row"><label for="noise-l0">도로 7.5m 지점 소음도(dB)</label>
        <input type="number" id="noise-l0" value="68" min="40" max="90" step="1" /></div>
      <div class="row"><label for="noise-limit">기준(dB)</label>
        <input type="number" id="noise-limit" value="65" min="40" max="90" step="1" /></div>
      <div class="row"><label for="noise-dist">최대 거리(m)</label>
        <input type="number" id="noise-dist" value="300" min="50" max="1000" step="50" /></div>
      <div class="row"><label for="noise-step">외벽 측정 간격(m)</label>
        <input type="number" id="noise-step" value="6" min="2" max="20" step="1" /></div>
      <p class="hint">도로마다 교통량이 달라도 한 값으로 계산합니다. 지면·공기 흡음, 반사는 반영하지 않습니다.</p>`,
    async run(onProgress) {
      result = await runNoise(
        ctx.project,
        {
          l0: numInput("noise-l0", 68, 40, 90),
          limit: numInput("noise-limit", 65, 40, 90),
          maxDist: numInput("noise-dist", 300, 50, 1000),
          step: numInput("noise-step", 6, 2, 20),
        },
        onProgress,
      );
      const c = new THREE.Color();
      overlay = facadePanels(
        result.points.map((p) => ({ position: p.position, normal: p.normal, color: noiseColor(p.db, c).clone() })),
        "noise",
      );
      ctx.viewer.scene.add(overlay);
      return `도로소음 — ${result.limit}dB 이상 ${over()} / ${result.points.length} 측정점 (${pct(over(), result.points.length)})`;
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    summaryHtml() {
      const r = result!;
      const maxDb = Math.max(...r.points.map((p) => p.db));
      return (
        `<div class="an-big">${pct(over(), r.points.length)}</div>` +
        `<div class="hint">${r.limit}dB 이상 측정점 ${over()} / ${r.points.length} · 최고 ${maxDb.toFixed(1)}dB</div>` +
        `<div class="hint">기준 초과 동 ${r.buildings.filter((b) => b.over > 0).length} / ${r.buildings.length}</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "gradient",
          title: "도로소음 간이 예측 (dB)",
          stops: gradientFromStops(
            NOISE_STOPS.map(([v, c]) => [v - 45, c]),
            30,
          ),
          ticks: [45, 55, 65, 75].map((v) => ({ at: (v - 45) / 30, label: v === 75 ? "75+" : `${v}` })),
          note: `도로 7.5m ${r.l0}dB 가정 · ${r.limit}dB 이상 ${pct(over(), r.points.length)}`,
        },
      ];
    },
    board() {
      const r = result!;
      const items: BoardItem[] = [...r.buildings]
        .sort((a, b) => b.max - a.max)
        .map((b) => ({
          label: `${b.name} — 최고 ${b.max.toFixed(1)}dB · 초과 ${b.over}/${b.points}`,
          verdict: b.over > 0 ? "bad" : "ok",
          at: b.at,
        }));
      return {
        title: "도로소음 (간이)",
        value: `${r.limit}dB 이상 ${over()} / ${r.points.length} 측정점 (${pct(over(), r.points.length)})`,
        verdict: over() > 0 ? "warn" : "ok",
        items,
      };
    },
    excel() {
      const r = result!;
      const name = new Map(r.buildings.map((b) => [b.id, b.name]));
      return {
        name: "도로소음",
        rows: [
          ["도로소음 간이 예측", `도로 7.5m ${r.l0}dB · 기준 ${r.limit}dB · Maekawa 회절 · 지면/공기 흡음·반사 미반영`],
          [],
          ["동", "측정점", "기준 초과", "최고(dB)"],
          ...r.buildings.map((b) => [b.name, b.points, b.over, Math.round(b.max * 10) / 10]),
          [],
          ["동", "층", "X", "Y", "소음도(dB)"],
          ...r.points.map((p) => [
            name.get(p.buildingId) ?? "",
            p.floor,
            Math.round(p.position.x * 10) / 10,
            Math.round(-p.position.z * 10) / 10,
            Math.round(p.db * 10) / 10,
          ]),
        ],
        widths: [16, 10, 10, 10, 12],
      };
    },
  };
}
