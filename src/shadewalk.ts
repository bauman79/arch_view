import * as THREE from "three";
import { worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule } from "./analyses";
import { disposeObject, numInput, pct, selInput } from "./analyses";
import { pointInPolygon } from "./geom2d";
import { pointShaded, shadowCasters, sunPlan, type ShadowCaster } from "./groundshadow";
import { gradientFromStops } from "./legend";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import type { Canopy, OverlayLine, Point2, Project } from "./types";

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
  /** 그늘 비율 — 사업 전(계획동·차양 없음) / 사업 후(계획동) / 사업 후 + 차양 */
  before: number;
  after: number;
  canopy: number;
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
  /** 차양까지 넣은 그늘 보행 비율 (차양이 없으면 ratioAfter와 같음) */
  ratioCanopy: number;
  canopyCount: number;
  totalLen: number;
  source: "ROAD_AREA" | "ROAD_CL";
}

const SAMPLE_M = 3;
/** 차양 판 두께 (m) */
const CANOPY_T = 0.15;

/** 차양 → 그림자 장애물 (a→b 중심선, 폭 width, 지반 위 height의 얇은 판) */
export function canopyFootprint(c: Canopy): Point2[] {
  const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (c.width / 2), ny = (dx / L) * (c.width / 2);
  return [
    { x: c.a.x + nx, y: c.a.y + ny },
    { x: c.b.x + nx, y: c.b.y + ny },
    { x: c.b.x - nx, y: c.b.y - ny },
    { x: c.a.x - nx, y: c.a.y - ny },
  ];
}

export function canopyCasters(canopies: Canopy[]): ShadowCaster[] {
  return canopies.map((c) => {
    const fp = canopyFootprint(c);
    return {
      id: c.id,
      fp,
      base: Math.max(0, c.height - CANOPY_T),
      height: c.height,
      minX: Math.min(...fp.map((p) => p.x)),
      minY: Math.min(...fp.map((p) => p.y)),
      maxX: Math.max(...fp.map((p) => p.x)),
      maxY: Math.max(...fp.map((p) => p.y)),
    };
  });
}

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
  opts: { date: string; startMin: number; endMin: number; radius: number; threshold: number; halfWidth: number; canopies?: Canopy[] },
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
  const castCanopy = canopyCasters(opts.canopies ?? []);
  const points: WalkPoint[] = pts.map((w) => ({ ...w, before: 0, after: 0, canopy: 0 }));
  const CHUNK = 300;
  for (let i = 0; i < points.length; i += CHUNK) {
    const end = Math.min(points.length, i + CHUNK);
    for (let k = i; k < end; k++) {
      const w = points[k];
      let b = 0, a = 0, c = 0;
      for (const sp of suns) {
        if (!sp) { b++; a++; c++; continue; }
        if (pointShaded(w.p.x, w.p.y, castBefore, sp)) { b++; a++; c++; continue; }
        if (pointShaded(w.p.x, w.p.y, castAll, sp)) { a++; c++; continue; }
        if (castCanopy.length && pointShaded(w.p.x, w.p.y, castCanopy, sp)) c++;
      }
      w.before = b / suns.length;
      w.after = a / suns.length;
      w.canopy = c / suns.length;
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
    ratioCanopy: ratio((w) => w.canopy),
    canopyCount: castCanopy.length,
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
    inst.setColorAt(i, shadeColor(w.canopy, c));
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

/** 차양 3D 표시 — 기둥 2개 + 판, 그림자를 드리운다 */
export function createCanopyGroup(canopies: Canopy[], elevate: ((x: number, y: number) => number) | undefined): THREE.Group {
  const g = new THREE.Group();
  g.name = "canopies";
  const slabMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const postMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  for (const c of canopies) {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 0.1) continue;
    const mx = (c.a.x + c.b.x) / 2, my = (c.a.y + c.b.y) / 2;
    const gl = elevate ? elevate(mx, my) : 0;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(L, CANOPY_T, c.width), slabMat);
    slab.position.set(mx, gl + c.height - CANOPY_T / 2, -my);
    slab.rotation.y = Math.atan2(dy, dx);
    slab.castShadow = true;
    slab.receiveShadow = true;
    g.add(slab);
    for (const p of [c.a, c.b]) {
      const pg = elevate ? elevate(p.x, p.y) : 0;
      const h = Math.max(0.5, gl + c.height - pg);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.2), postMat);
      post.position.set(p.x, pg + h / 2, -p.y);
      post.castShadow = true;
      g.add(post);
    }
  }
  return g;
}

export function createShadeWalkModule(ctx: AnalysisContext): AnalysisModule {
  let result: ShadeWalkResult | null = null;
  let overlay: THREE.Object3D | null = null;
  let canopyGroup: THREE.Group | null = null;
  let seq = 0;

  const drawCanopies = () => {
    disposeObject(canopyGroup);
    canopyGroup = createCanopyGroup(ctx.project.canopies ?? [], ctx.elevate());
    ctx.viewer.scene.add(canopyGroup);
    renderList();
  };
  const renderList = () => {
    const box = document.getElementById("shadewalk-canopy-list");
    if (!box) return;
    const list = ctx.project.canopies ?? [];
    box.innerHTML = list.length
      ? list
          .map((c, i) => {
            const L = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
            return `<div class="canopy-row"><span>차양 ${i + 1} · 길이 ${L.toFixed(1)}m · 폭 ${c.width}m · 높이 ${c.height}m</span>` +
              `<button class="btn mini" data-del="${c.id}" title="이 차양 삭제">×</button></div>`;
          })
          .join("")
      : `<p class="hint">차양 없음 — "차양 추가"를 누르고 지도에서 시작점·끝점을 찍으세요.</p>`;
    for (const b of box.querySelectorAll<HTMLButtonElement>("button[data-del]")) {
      b.addEventListener("click", () => {
        ctx.project.canopies = (ctx.project.canopies ?? []).filter((c) => c.id !== b.dataset.del);
        canopiesChanged("차양을 삭제했습니다");
      });
    }
  };
  const canopiesChanged = (msg: string) => {
    drawCanopies();
    if (result) {
      result = null;
      disposeObject(overlay);
      overlay = null;
      const sum = document.getElementById("shadewalk-summary");
      if (sum) sum.innerHTML = `<p class="hint">차양이 바뀌었습니다 — 다시 실행하세요.</p>`;
      ctx.changed();
      ctx.setStatus(`${msg} — 그늘보행권 결과를 지웠습니다. 다시 실행하세요.`);
    } else ctx.setStatus(msg);
  };

  return {
    id: "shadewalk",
    slot: "env",
    title: "가로 그늘보행권",
    hint: "폭염 시간대 보도가 그늘에 드는 비율 — 사업 전·후·차양 설치 후 비교 (가로수 미반영)",
    bodyHtml: `
      <div class="row"><label for="shadewalk-cw">차양 폭(m)</label>
        <input type="number" id="shadewalk-cw" value="3" min="0.5" max="20" step="0.5" /></div>
      <div class="row"><label for="shadewalk-ch">차양 높이(m)</label>
        <input type="number" id="shadewalk-ch" value="3.5" min="2" max="15" step="0.5" /></div>
      <div class="row">
        <button class="btn mini" id="shadewalk-add">차양 추가 (지도에서 두 점)</button>
        <button class="btn mini" id="shadewalk-clear-canopies">차양 모두 지우기</button>
      </div>
      <div id="shadewalk-canopy-list"></div>`,
    onMount() {
      document.getElementById("shadewalk-add")!.addEventListener("click", async () => {
        if (!ctx.pickGroundPoints) return;
        const width = numInput("shadewalk-cw", 3, 0.5, 20);
        const height = numInput("shadewalk-ch", 3.5, 2, 15);
        const pts = await ctx.pickGroundPoints(2, "차양 시작점을 지도에서 찍으세요");
        if (!pts) return;
        if (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 0.5) {
          ctx.setStatus("두 점이 너무 가깝습니다 — 다시 추가하세요.");
          return;
        }
        ctx.project.canopies = [
          ...(ctx.project.canopies ?? []),
          { id: `C${Date.now().toString(36)}${seq++}`, a: pts[0], b: pts[1], width, height },
        ];
        canopiesChanged(`차양을 추가했습니다 (${ctx.project.canopies.length}개)`);
      });
      document.getElementById("shadewalk-clear-canopies")!.addEventListener("click", () => {
        if (!(ctx.project.canopies ?? []).length) return;
        ctx.project.canopies = [];
        canopiesChanged("차양을 모두 지웠습니다");
      });
      renderList();
    },
    onProjectLoaded() {
      drawCanopies();
    },
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
          canopies: ctx.project.canopies ?? [],
        },
        onProgress,
      );
      overlay = createShadeWalkOverlay(result, ctx.elevate());
      ctx.viewer.scene.add(overlay);
      return (
        `그늘보행권 — 그늘 보행 비율 ${(result.ratioCanopy * 100).toFixed(1)}% ` +
        `(사업 전 ${(result.ratioBefore * 100).toFixed(1)}%` +
        (result.canopyCount ? ` · 차양 전 ${(result.ratioAfter * 100).toFixed(1)}%` : "") +
        `) · 보도 ${Math.round(result.totalLen)}m`
      );
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    setVisible(on: boolean) {
      if (overlay) overlay.visible = on;
    },
    summaryHtml() {
      const r = result!;
      const d = (r.ratioAfter - r.ratioBefore) * 100;
      const dc = (r.ratioCanopy - r.ratioAfter) * 100;
      return (
        `<div class="an-big">${(r.ratioCanopy * 100).toFixed(1)}%</div>` +
        `<div class="hint">사업 전 ${(r.ratioBefore * 100).toFixed(1)}% → 사업 후 ${(r.ratioAfter * 100).toFixed(1)}% (${d >= 0 ? "+" : ""}${d.toFixed(1)}%p)</div>` +
        (r.canopyCount
          ? `<div class="hint">차양 ${r.canopyCount}개 설치 효과 ${dc >= 0 ? "+" : ""}${dc.toFixed(1)}%p</div>`
          : "") +
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
          note:
            `그늘 보행 ${(r.ratioCanopy * 100).toFixed(1)}% (사업 전 ${(r.ratioBefore * 100).toFixed(1)}%` +
            (r.canopyCount ? `, 차양 ${r.canopyCount}개 포함` : "") +
            `) · 가로수 미반영`,
        },
      ];
    },
    board() {
      const r = result!;
      const d = (r.ratioAfter - r.ratioBefore) * 100;
      return {
        title: "가로 그늘보행권",
        value:
          `그늘 보행 ${pct(r.ratioCanopy, 1)} (사업 전 ${pct(r.ratioBefore, 1)}, 사업 ${d >= 0 ? "+" : ""}${d.toFixed(1)}%p` +
          (r.canopyCount ? `, 차양 ${r.canopyCount}개 +${((r.ratioCanopy - r.ratioAfter) * 100).toFixed(1)}%p` : "") +
          `)`,
        verdict: "info",
      };
    },
    excel() {
      const r = result!;
      const cs = ctx.project.canopies ?? [];
      return {
        name: "그늘보행권",
        rows: [
          ["가로 그늘보행권", `${r.date} ${hm(r.startMin)}~${hm(r.endMin)} · 그늘 기준 ${Math.round(r.threshold * 100)}% · 건물·차양 그림자(가로수 미반영)`],
          ["보도 연장(m)", Math.round(r.totalLen)],
          ["그늘 보행 비율 — 사업 전", pct(r.ratioBefore, 1)],
          ["그늘 보행 비율 — 사업 후", pct(r.ratioAfter, 1)],
          ["그늘 보행 비율 — 사업 후 + 차양", pct(r.ratioCanopy, 1)],
          [],
          ["차양", "길이(m)", "폭(m)", "높이(m)"],
          ...cs.map((c, i) => [`차양 ${i + 1}`, Math.round(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) * 10) / 10, c.width, c.height]),
          [],
          ["X", "Y", "사업 전 그늘(%)", "사업 후 그늘(%)", "차양 포함(%)"],
          ...r.points.map((w) => [
            Math.round(w.p.x * 10) / 10,
            Math.round(w.p.y * 10) / 10,
            Math.round(w.before * 100),
            Math.round(w.after * 100),
            Math.round(w.canopy * 100),
          ]),
        ],
        widths: [26, 30, 14, 14, 14],
      };
    },
  };
}
