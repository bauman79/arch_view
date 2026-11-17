import * as THREE from "three";
import { footprintCentroid, worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule, BoardItem } from "./analyses";
import { disposeObject, numInput, selInput, textSprite } from "./analyses";
import { buildLinesDxf, type DxfLineLayer } from "./dxfexport";
import {
  contourSegments,
  insideMask,
  makeGrid,
  polygonMask,
  sitePolygons,
  segmentsToRibbon,
  shadowCasters,
  shadowMask,
  sunPlan,
  type GroundGrid,
} from "./groundshadow";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import type { Point2, Project } from "./types";
import { hexCss } from "./legend";

/**
 * 일영도 — 기준일(기본 동지) 시간별 그림자 윤곽선 + 등시간선(그림자가 N시간 이상 지는 범위).
 * 심의 도서의 일영도 형식. 평지 해석 그림자(groundshadow.ts)로 계산하고 DXF로 내보낸다.
 */

export interface ShadowPlanResult {
  date: string;
  startMin: number;
  endMin: number;
  stepMin: number;
  grid: GroundGrid;
  /** 셀별 그늘 시간 (h) */
  hours: Float32Array;
  hourly: { minutes: number; segs: [Point2, Point2][]; label: Point2 | null }[];
  iso: { level: number; segs: [Point2, Point2][] }[];
  /** 등시간선 단계별 대지 밖 면적 (㎡) — 건물 내부 제외 */
  outsideArea: { level: number; area: number }[];
  /** 최고 단계 안에 걸리는 인접건물 */
  affected: { id: string; name: string; at: THREE.Vector3 }[];
  target: "plan" | "all";
}

export const ISO_COLORS = [0xfacc15, 0xf97316, 0xdc2626, 0x7f1d1d, 0x4c0519];

function hourColor(i: number, n: number): number {
  const c = new THREE.Color().setHSL(0.58 - (0.5 * i) / Math.max(1, n - 1), 0.7, 0.6);
  return c.getHex();
}

export async function runShadowPlan(
  project: Project,
  opts: { startMin: number; endMin: number; stepMin: number; cell: number; levels: number[]; target: "plan" | "all" },
  onProgress: (pct: number) => void,
): Promise<ShadowPlanResult> {
  const { site, analysis, buildings } = project;
  const plans = buildings.filter((b) => b.type === "계획주동");
  if (plans.length === 0) throw new Error("계획주동이 없습니다");
  const casterBuildings = opts.target === "plan" ? plans : buildings;
  const casters = shadowCasters(casterBuildings);
  const samples = sunSamples(analysis.date, site.latitude, site.longitude, site.northAngle, opts.startMin, opts.endMin - opts.stepMin, opts.stepMin);

  // 범위 — 계획주동 bbox + 가장 긴 그림자 길이
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of plans) for (const p of worldFootprint(b)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const hMax = Math.max(...shadowCasters(plans).map((c) => c.height), 1);
  let minTan = Infinity;
  for (const s of samples) {
    const sp = s.dir ? sunPlan(s.dir) : null;
    if (sp) minTan = Math.min(minTan, sp.tan);
  }
  const reach = Math.min(500, hMax / Math.max(0.05, minTan)) + 10;
  const grid = makeGrid(minX - reach, minY - reach, maxX + reach, maxY + reach, opts.cell);
  const n = grid.nx * grid.ny;
  const hours = new Float32Array(n);
  const mask = new Uint8Array(n);
  const stepH = opts.stepMin / 60;
  const hourly: ShadowPlanResult["hourly"] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    shadowMask(grid, casters, s.dir, mask);
    for (let k = 0; k < n; k++) if (mask[k]) hours[k] += stepH;
    if (s.minutes % 60 === 0) {
      const segs = contourSegments(grid, mask, 0.5);
      // 라벨 — 태양 반대쪽으로 가장 먼 점
      let label: Point2 | null = null;
      const sp = s.dir ? sunPlan(s.dir) : null;
      if (sp && segs.length) {
        let best = -Infinity;
        for (const [a] of segs) {
          const d = -(a.x * sp.dx + a.y * sp.dy);
          if (d > best) {
            best = d;
            label = a;
          }
        }
      }
      hourly.push({ minutes: s.minutes, segs, label });
    }
    onProgress(((i + 1) / samples.length) * 90);
    if (i % 4 === 3) await yieldToEventLoop();
  }
  // 마지막 정시(예: 15시)도 윤곽선에 포함
  if (opts.endMin % 60 === 0 && !hourly.some((h) => h.minutes === opts.endMin)) {
    const last = sunSamples(analysis.date, site.latitude, site.longitude, site.northAngle, opts.endMin, opts.endMin, 1)[0];
    shadowMask(grid, casters, last.dir, mask);
    const segs = contourSegments(grid, mask, 0.5);
    let label: Point2 | null = null;
    const sp = last.dir ? sunPlan(last.dir) : null;
    if (sp && segs.length) {
      let best = -Infinity;
      for (const [a] of segs) {
        const d = -(a.x * sp.dx + a.y * sp.dy);
        if (d > best) { best = d; label = a; }
      }
    }
    hourly.push({ minutes: opts.endMin, segs, label });
  }

  const inside = insideMask(grid, buildings);
  const sites = sitePolygons(project.siteOverlays);
  const iso = opts.levels.map((level) => ({ level, segs: contourSegments(grid, hours, level - 1e-6) }));
  const cellA = grid.cell * grid.cell;
  const siteM = sites.length ? polygonMask(grid, sites) : null;
  const outsideArea = opts.levels.map((level) => {
    let a = 0;
    for (let k = 0; k < n; k++) {
      if (hours[k] < level - 1e-6 || inside[k] || (siteM && siteM[k])) continue;
      a += cellA;
    }
    return { level, area: a };
  });
  const top = opts.levels.length ? Math.max(...opts.levels) : 4;
  const affected: ShadowPlanResult["affected"] = [];
  for (const b of buildings) {
    if (b.type !== "인접건물") continue;
    const fp = worldFootprint(b);
    // 외곽 꼭짓점·변 중점 중 하나라도 최고 단계 이상이면 영향
    const probes: Point2[] = [];
    fp.forEach((p, i) => {
      const q = fp[(i + 1) % fp.length];
      probes.push(p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    });
    const hit = probes.some((p) => {
      const ix = Math.floor((p.x - grid.minX) / grid.cell);
      const iy = Math.floor((p.y - grid.minY) / grid.cell);
      if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) return false;
      return hours[iy * grid.nx + ix] >= top - 1e-6;
    });
    if (hit) {
      const c = footprintCentroid(fp);
      affected.push({ id: b.id, name: b.name, at: new THREE.Vector3(c.x, (b.terrainElevation ?? 0) + 5, -c.y) });
    }
  }
  onProgress(100);
  return {
    date: analysis.date,
    startMin: opts.startMin,
    endMin: opts.endMin,
    stepMin: opts.stepMin,
    grid,
    hours,
    hourly,
    iso,
    outsideArea,
    affected,
    target: opts.target,
  };
}

export function createShadowPlanOverlay(r: ShadowPlanResult, elevate: ((x: number, y: number) => number) | undefined): THREE.Group {
  const g = new THREE.Group();
  g.name = "shadow-plan";
  r.hourly.forEach((h, i) => {
    const col = hourColor(i, r.hourly.length);
    // 1px GL 선은 멀리서 지면에 묻히므로 얇은 띠로 그린다
    g.add(segmentsToRibbon(h.segs, col, 0.35, elevate, 0.35));
    if (h.label) {
      const sp = textSprite(`${h.minutes / 60}시`, hexCss(col), 5);
      sp.position.set(h.label.x, (elevate ? elevate(h.label.x, h.label.y) : 0) + 4, -h.label.y);
      g.add(sp);
    }
  });
  r.iso.forEach((s, i) => {
    g.add(segmentsToRibbon(s.segs, ISO_COLORS[i % ISO_COLORS.length], 1.0, elevate, 0.45 + i * 0.03));
  });
  return g;
}

function hm(m: number): string {
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export function shadowPlanDxfLayers(r: ShadowPlanResult): DxfLineLayer[] {
  const layers: DxfLineLayer[] = r.hourly.map((h, i) => ({
    name: `SHADOW_${String(h.minutes / 60).padStart(2, "0")}`,
    color: [5, 4, 3, 2, 30, 6, 1, 8, 9][i % 9],
    segments: h.segs,
    texts: h.label ? [{ at: h.label, height: 3, text: `${h.minutes / 60}시` }] : [],
  }));
  r.iso.forEach((s, i) => {
    layers.push({ name: `SHADOW_ISO_${s.level}H`, color: [2, 30, 1, 14, 16][i % 5], segments: s.segs });
  });
  return layers;
}

export function createShadowPlanModule(ctx: AnalysisContext): AnalysisModule {
  let result: ShadowPlanResult | null = null;
  let overlay: THREE.Group | null = null;
  const levelsOf = () =>
    selInput("shadowplan-levels", "2,3,4")
      .split(",")
      .map((x) => parseFloat(x))
      .filter((x) => Number.isFinite(x) && x > 0)
      .sort((a, b) => a - b);
  return {
    id: "shadowplan",
    slot: "sun",
    title: "일영도 (시간별 그림자·등시간선)",
    hint: "기준일(상단 날짜) 시간별 그림자 윤곽 + 그림자가 N시간 이상 지는 범위 · 평지 가정",
    settingsHtml: `
      <div class="row"><label for="shadowplan-range">시간대</label>
        <select id="shadowplan-range">
          <option value="540-900" selected>09~15시</option>
          <option value="480-960">08~16시</option>
        </select></div>
      <div class="row"><label for="shadowplan-levels">등시간선(h)</label>
        <select id="shadowplan-levels">
          <option value="2,3,4" selected>2·3·4시간</option>
          <option value="1,2,3,4,5">1~5시간</option>
          <option value="3,4">3·4시간</option>
        </select></div>
      <div class="row"><label for="shadowplan-target">그림자 대상</label>
        <select id="shadowplan-target">
          <option value="plan" selected>계획주동만</option>
          <option value="all">계획주동+인접건물</option>
        </select></div>
      <div class="row"><label for="shadowplan-cell">격자(m)</label>
        <input type="number" id="shadowplan-cell" value="2" min="0.5" max="5" step="0.5" /></div>`,
    extraButtons: [
      {
        id: "shadowplan-dxf",
        label: "일영도 DXF 내보내기",
        onClick: async () => {
          if (!result) {
            ctx.setStatus("먼저 일영도를 실행하세요.");
            return;
          }
          const text = buildLinesDxf(shadowPlanDxfLayers(result), ctx.sceneOrigin());
          const name = `일영도_${result.date}.dxf`;
          await ctx.saveFile(new Blob([text], { type: "application/dxf" }), name, "DXF 도면", {
            "application/dxf": [".dxf"],
          });
        },
      },
    ],
    async run(onProgress) {
      const [a, b] = selInput("shadowplan-range", "540-900").split("-").map(Number);
      const levels = levelsOf();
      result = await runShadowPlan(
        ctx.project,
        {
          startMin: a,
          endMin: b,
          stepMin: 10,
          cell: numInput("shadowplan-cell", 2, 0.5, 5),
          levels,
          target: selInput("shadowplan-target", "plan") as "plan" | "all",
        },
        onProgress,
      );
      overlay = createShadowPlanOverlay(result, ctx.elevate());
      ctx.viewer.scene.add(overlay);
      const top = result.outsideArea[result.outsideArea.length - 1];
      return (
        `일영도 완료 (${result.date} ${hm(a)}~${hm(b)}) — ` +
        (top ? `${top.level}시간 이상 그늘(대지 밖) ${Math.round(top.area).toLocaleString()}㎡ · ` : "") +
        `영향 인접건물 ${result.affected.length}동`
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
      return (
        r.outsideArea
          .map((o) => `<div class="hint">${o.level}시간 이상 그늘 (대지 밖) ${Math.round(o.area).toLocaleString()}㎡</div>`)
          .join("") +
        `<div class="hint">최고 단계 안에 걸린 인접건물 ${r.affected.length}동</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "swatches",
          title: `일영도 — ${r.date} ${hm(r.startMin)}~${hm(r.endMin)}`,
          items: [
            ...r.iso.map((s, i) => ({ color: hexCss(ISO_COLORS[i % ISO_COLORS.length]), label: `${s.level}시간 이상 그늘` })),
            { color: hexCss(hourColor(0, 2)), label: "시간별 그림자 윤곽" },
          ],
          note: r.target === "plan" ? "계획주동 그림자만 · 평지 가정" : "계획주동+인접건물 그림자 · 평지 가정",
        },
      ];
    },
    board() {
      const r = result!;
      const top = r.outsideArea[r.outsideArea.length - 1];
      const items: BoardItem[] = r.affected.map((a) => ({ label: a.name, verdict: "warn", at: a.at }));
      return {
        title: "일영도",
        value: top
          ? `${top.level}h 이상 그늘(대지 밖) ${Math.round(top.area).toLocaleString()}㎡ · 인접건물 ${r.affected.length}동`
          : "—",
        verdict: r.affected.length > 0 ? "warn" : "ok",
        items,
      };
    },
    excel() {
      const r = result!;
      return {
        name: "일영도",
        rows: [
          ["일영도", `${r.date} ${hm(r.startMin)}~${hm(r.endMin)} · ${r.stepMin}분 간격 · 격자 ${r.grid.cell}m · 평지 가정`],
          ["그림자 대상", r.target === "plan" ? "계획주동만" : "계획주동+인접건물"],
          [],
          ["등시간 단계", "대지 밖 그늘 면적(㎡)"],
          ...r.outsideArea.map((o) => [`${o.level}시간 이상`, Math.round(o.area)]),
          [],
          ["최고 단계 안에 걸린 인접건물"],
          ...r.affected.map((a) => [a.name]),
        ],
        widths: [24, 40],
      };
    },
  };
}
