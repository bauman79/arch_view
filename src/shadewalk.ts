import * as THREE from "three";
import { worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule } from "./analyses";
import { disposeObject, numInput, pct, selInput } from "./analyses";
import { pointInPolygon } from "./geom2d";
import { pointShaded, shadowCasters, sunPlan, type ShadowCaster } from "./groundshadow";
import { gradientFromStops } from "./legend";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import type { OverlayLine, Point2, Project } from "./types";

/**
 * 가로 그늘보행권 — 폭염 시간대(기본 8월 초 11~16시)에 보도가 그늘에 드는 비율.
 * 보도 위치는 도로 영역(ROAD_AREA) 가장자리에서 1.5m 안쪽, 없으면 도로중심선(ROAD_CL)
 * 양옆 반폭 지점으로 잡는다. 사업 전(계획주동 없음)·후를 비교해 사업이 가로 그늘을
 * 얼마나 늘리거나 줄이는지 본다. ⚠️ 가로수·차양·아케이드는 반영하지 않는다(건물 그림자만).
 */

export interface WalkPoint {
  p: Point2;
  /** 보도 구간 길이 (m) — 이 점이 대표하는 길이 */
  len: number;
  before: number;
  after: number;
}

export interface ShadeWalkResult {
  date: string;
  startMin: number;
  endMin: number;
  threshold: number;
  points: WalkPoint[];
  /** 그늘 보행 비율 (길이 가중, threshold 이상 그늘인 보도 길이 / 전체) */
  ratioBefore: number;
  ratioAfter: number;
  totalLen: number;
  source: "ROAD_AREA" | "ROAD_CL";
}

const SAMPLE_M = 3;

/** 폴리라인을 간격 step으로 나눈 점 + 진행 방향 */
function samplePolyline(pts: Point2[], closed: boolean, step: number): { p: Point2; t: Point2 }[] {
  const out: { p: Point2; t: Point2 }[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-6) continue;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const k = Math.max(1, Math.round(L / step));
    for (let j = 0; j < k; j++) {
      const s = (j + 0.5) / k;
      out.push({ p: { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s }, t });
    }
  }
  return out;
}

/** 보도 측정점 — ROAD_AREA 가장자리 안쪽 1.5m, 없으면 ROAD_CL ± 반폭 */
export function sidewalkPoints(
  overlays: OverlayLine[],
  near: (p: Point2) => boolean,
  halfWidthM: number,
): { points: { p: Point2; len: number }[]; source: "ROAD_AREA" | "ROAD_CL" } {
  const areas = overlays.filter((o) => o.layer === "ROAD_AREA" && o.closed && o.points.length >= 3);
  const out: { p: Point2; len: number }[] = [];
  if (areas.length > 0) {
    for (const a of areas) {
      for (const { p, t } of samplePolyline(a.points, true, SAMPLE_M)) {
        let n = { x: -t.y, y: t.x };
        if (!pointInPolygon(p.x + n.x * 0.5, p.y + n.y * 0.5, a.points)) n = { x: -n.x, y: -n.y };
        const q = { x: p.x + n.x * 1.5, y: p.y + n.y * 1.5 };
        if (near(q)) out.push({ p: q, len: SAMPLE_M });
      }
    }
    return { points: out, source: "ROAD_AREA" };
  }
  for (const o of overlays.filter((x) => x.layer === "ROAD_CL" && x.points.length >= 2)) {
    for (const { p, t } of samplePolyline(o.points, o.closed, SAMPLE_M)) {
      for (const sgn of [1, -1]) {
        const q = { x: p.x - t.y * halfWidthM * sgn, y: p.y + t.x * halfWidthM * sgn };
        if (near(q)) out.push({ p: q, len: SAMPLE_M });
      }
    }
  }
  return { points: out, source: "ROAD_CL" };
}

export async function runShadeWalk(
  project: Project,
  opts: { date: string; startMin: number; endMin: number; radius: number; threshold: number; halfWidth: number },
  onProgress: (pct: number) => void,
): Promise<ShadeWalkResult> {
  const { site, buildings } = project;
  const plans = buildings.filter((b) => b.type === "계획주동");
  if (plans.length === 0) throw new Error("계획주동이 없습니다");
  const planFps = plans.map((b) => worldFootprint(b));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fp of planFps) for (const p of fp) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const R = opts.radius;
  const near = (p: Point2) => p.x > minX - R && p.x < maxX + R && p.y > minY - R && p.y < maxY + R;
  const { points: raw, source } = sidewalkPoints(project.siteOverlays, near, opts.halfWidth);
  if (raw.length === 0) throw new Error("보도를 잡을 도로 정보(ROAD_AREA 또는 ROAD_CL)가 없습니다");
  // 건물 안으로 들어간 점은 제외
  const allFps = buildings.map((b) => worldFootprint(b));
  const pts = raw.filter((w) => !allFps.some((fp) => pointInPolygon(w.p.x, w.p.y, fp)));

  const step = 10;
  const samples = sunSamples(opts.date, site.latitude, site.longitude, site.northAngle, opts.startMin, opts.endMin - step, step);
  const castAll: ShadowCaster[] = shadowCasters(buildings);
  const castBefore = castAll.filter((c) => !plans.some((p) => p.id === c.id));
  const suns = samples.map((s) => (s.dir ? sunPlan(s.dir) : null));
  const points: WalkPoint[] = pts.map((w) => ({ ...w, before: 0, after: 0 }));
  const CHUNK = 300;
  for (let i = 0; i < points.length; i += CHUNK) {
    const end = Math.min(points.length, i + CHUNK);
    for (let k = i; k < end; k++) {
      const w = points[k];
      let b = 0, a = 0;
      for (const sp of suns) {
        if (!sp) { b++; a++; continue; }
        if (pointShaded(w.p.x, w.p.y, castBefore, sp)) { b++; a++; continue; }
        if (pointShaded(w.p.x, w.p.y, castAll, sp)) a++;
      }
      w.before = b / suns.length;
      w.after = a / suns.length;
    }
    onProgress((end / points.length) * 100);
    if (end < points.length) await yieldToEventLoop();
  }
  const total = points.reduce((s, w) => s + w.len, 0);
  const ratio = (f: (w: WalkPoint) => number) =>
    total > 0 ? points.filter((w) => f(w) >= opts.threshold - 1e-9).reduce((s, w) => s + w.len, 0) / total : 0;
  return {
    date: opts.date,
    startMin: opts.startMin,
    endMin: opts.endMin,
    threshold: opts.threshold,
    points,
    ratioBefore: ratio((w) => w.before),
    ratioAfter: ratio((w) => w.after),
    totalLen: total,
    source,
  };
}

/** 그늘 비율 컬러맵 — 0(종일 볕, 빨강) → 1(종일 그늘, 초록) */
export const SHADE_STOPS: [number, number][] = [
  [0, 0xef4444],
  [0.25, 0xf97316],
  [0.5, 0xfacc15],
  [0.75, 0x84cc16],
  [1, 0x16a34a],
];

function shadeColor(f: number, out = new THREE.Color()): THREE.Color {
  for (let i = 1; i < SHADE_STOPS.length; i++) {
    if (f <= SHADE_STOPS[i][0]) {
      const [v0, c0] = SHADE_STOPS[i - 1];
      const [v1, c1] = SHADE_STOPS[i];
      return out.set(c0).lerp(new THREE.Color(c1), (f - v0) / (v1 - v0));
    }
  }
  return out.set(SHADE_STOPS[SHADE_STOPS.length - 1][1]);
}

export function createShadeWalkOverlay(r: ShadeWalkResult, elevate: ((x: number, y: number) => number) | undefined): THREE.InstancedMesh {
  const geom = new THREE.CylinderGeometry(1.1, 1.1, 0.25, 10);
  const inst = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial(), Math.max(1, r.points.length));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  r.points.forEach((w, i) => {
    m.makeTranslation(w.p.x, (elevate ? elevate(w.p.x, w.p.y) : 0) + 0.45, -w.p.y);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, shadeColor(w.after, c));
  });
  inst.count = r.points.length;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.name = "shade-walk";
  return inst;
}

function hm(m: number): string {
  return `${Math.floor(m / 60)}시${m % 60 ? ` ${m % 60}분` : ""}`;
}

export function createShadeWalkModule(ctx: AnalysisContext): AnalysisModule {
  let result: ShadeWalkResult | null = null;
  let overlay: THREE.Object3D | null = null;
  return {
    id: "shadewalk",
    slot: "env",
    title: "가로 그늘보행권",
    hint: "폭염 시간대 보도가 건물 그늘에 드는 비율 — 사업 전·후 비교 (가로수 미반영)",
    settingsHtml: `
      <div class="row"><label for="shadewalk-date">기준일</label>
        <select id="shadewalk-date">
          <option value="08-01" selected>8월 1일 (폭염)</option>
          <option value="07-20">7월 20일</option>
          <option value="06-21">하지</option>
        </select></div>
      <div class="row"><label for="shadewalk-range">시간대</label>
        <select id="shadewalk-range">
          <option value="660-960" selected>11~16시</option>
          <option value="600-1020">10~17시</option>
          <option value="720-900">12~15시</option>
        </select></div>
      <div class="row"><label for="shadewalk-threshold">그늘 기준(시간대 중 %)</label>
        <input type="number" id="shadewalk-threshold" value="50" min="10" max="100" step="10" /></div>
      <div class="row"><label for="shadewalk-radius">검토 범위(계획동 주변 m)</label>
        <input type="number" id="shadewalk-radius" value="150" min="20" max="600" step="10" /></div>
      <div class="row"><label for="shadewalk-half">도로 반폭(ROAD_CL만 있을 때, m)</label>
        <input type="number" id="shadewalk-half" value="6" min="2" max="30" step="1" /></div>`,
    async run(onProgress) {
      const year = ctx.project.analysis.date.slice(0, 4);
      const [a, b] = selInput("shadewalk-range", "660-960").split("-").map(Number);
      result = await runShadeWalk(
        ctx.project,
        {
          date: `${year}-${selInput("shadewalk-date", "08-01")}`,
          startMin: a,
          endMin: b,
          radius: numInput("shadewalk-radius", 150, 20, 600),
          threshold: numInput("shadewalk-threshold", 50, 10, 100) / 100,
          halfWidth: numInput("shadewalk-half", 6, 2, 30),
        },
        onProgress,
      );
      overlay = createShadeWalkOverlay(result, ctx.elevate());
      ctx.viewer.scene.add(overlay);
      return (
        `그늘보행권 — 그늘 보행 비율 ${(result.ratioAfter * 100).toFixed(1)}% ` +
        `(사업 전 ${(result.ratioBefore * 100).toFixed(1)}%) · 보도 ${Math.round(result.totalLen)}m`
      );
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    summaryHtml() {
      const r = result!;
      const d = (r.ratioAfter - r.ratioBefore) * 100;
      return (
        `<div class="an-big">${(r.ratioAfter * 100).toFixed(1)}%</div>` +
        `<div class="hint">그늘 보행 비율 (사업 전 ${(r.ratioBefore * 100).toFixed(1)}%, ${d >= 0 ? "+" : ""}${d.toFixed(1)}%p)</div>` +
        `<div class="hint">보도 ${Math.round(r.totalLen).toLocaleString()}m · ${r.date} ${hm(r.startMin)}~${hm(r.endMin)} · ${r.source === "ROAD_AREA" ? "도로영역 가장자리" : "도로중심선 ± 반폭"}</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "gradient",
          title: `그늘보행권 — ${r.date} ${hm(r.startMin)}~${hm(r.endMin)} 그늘 비율`,
          stops: gradientFromStops(SHADE_STOPS, 1),
          ticks: [
            { at: 0, label: "종일 볕" },
            { at: 0.5, label: "50%" },
            { at: 1, label: "종일 그늘" },
          ],
          note: `그늘 보행 비율 ${(r.ratioAfter * 100).toFixed(1)}% (사업 전 ${(r.ratioBefore * 100).toFixed(1)}%) · 가로수 미반영`,
        },
      ];
    },
    board() {
      const r = result!;
      const d = (r.ratioAfter - r.ratioBefore) * 100;
      return {
        title: "가로 그늘보행권",
        value: `그늘 보행 ${pct(r.ratioAfter, 1)} (사업 전 ${pct(r.ratioBefore, 1)}, ${d >= 0 ? "+" : ""}${d.toFixed(1)}%p)`,
        verdict: "info",
      };
    },
    excel() {
      const r = result!;
      return {
        name: "그늘보행권",
        rows: [
          ["가로 그늘보행권", `${r.date} ${hm(r.startMin)}~${hm(r.endMin)} · 그늘 기준 ${Math.round(r.threshold * 100)}% · 건물 그림자만(가로수 미반영)`],
          ["보도 연장(m)", Math.round(r.totalLen)],
          ["그늘 보행 비율 — 사업 전", pct(r.ratioBefore, 1)],
          ["그늘 보행 비율 — 사업 후", pct(r.ratioAfter, 1)],
          [],
          ["X", "Y", "사업 전 그늘(%)", "사업 후 그늘(%)"],
          ...r.points.map((w) => [
            Math.round(w.p.x * 10) / 10,
            Math.round(w.p.y * 10) / 10,
            Math.round(w.before * 100),
            Math.round(w.after * 100),
          ]),
        ],
        widths: [26, 30, 14, 14],
      };
    },
  };
}
