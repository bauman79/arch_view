import * as THREE from "three";
import { worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule } from "./analyses";
import { disposeObject, numInput, pct } from "./analyses";
import {
  gridHeatmap,
  insideMask,
  makeGrid,
  polygonMask,
  shadowCasters,
  shadowMask,
  sitePolygons,
  type GroundGrid,
} from "./groundshadow";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import type { Project } from "./types";
import { computeWindField, sampleWind, windDirLabel, type WindRoseData, type WindRoseStats } from "./wind";

/**
 * 외부공간 열쾌적성 (간이 지표) — 여름 그늘·통풍, 겨울 볕·바람막이를 합쳐
 * 외부공간을 "사계절 쾌적 / 여름 쾌적 / 겨울 쾌적 / 불리" 네 가지로 나눈다.
 * 놀이터·쉼터·벤치 위치를 정할 때 쓰는 비교용 지표이며 UTCI·PET 같은 정식 열쾌적
 * 지수가 아니다(기온·습도·복사 계산 없음).
 *
 * - 여름 점수 = 0.6 × (12~16시 그늘 비율, 8월 1일) + 0.4 × min(1, 여름 주풍 풍속비)
 * - 겨울 점수 = 0.6 × (10~14시 볕 비율, 동지) + 0.4 × (1 − min(1, 겨울 주풍 풍속비 / 1.2))
 * - 각 0.5 이상이면 그 계절 쾌적
 */

export type ComfortClass = "both" | "summer" | "winter" | "poor";

export const COMFORT_LABEL: Record<ComfortClass, string> = {
  both: "사계절 쾌적",
  summer: "여름 쾌적(겨울 불리)",
  winter: "겨울 쾌적(여름 불리)",
  poor: "불리",
};

export const COMFORT_COLOR: Record<ComfortClass, number> = {
  both: 0x22c55e,
  summer: 0x06b6d4,
  winter: 0xf59e0b,
  poor: 0xe5484d,
};

export function summerScore(shadeFrac: number, windRatio: number): number {
  return 0.6 * shadeFrac + 0.4 * Math.min(1, windRatio);
}

export function winterScore(sunFrac: number, windRatio: number): number {
  return 0.6 * sunFrac + 0.4 * (1 - Math.min(1, windRatio / 1.2));
}

export function classify(s: number, w: number): ComfortClass {
  const sg = s >= 0.5, wg = w >= 0.5;
  return sg && wg ? "both" : sg ? "summer" : wg ? "winter" : "poor";
}

export interface ThermalResult {
  grid: GroundGrid;
  /** 셀별 분류 (-1 = 대상 아님) */
  cls: Int8Array;
  area: Record<ComfortClass, number>;
  summerDir: number;
  winterDir: number;
  scope: "site" | "around";
}

/** 몇 달의 16방위 도수를 합쳐 계절 주풍향 */
export function seasonPrevailing(rose: WindRoseData, months: number[]): number {
  const acc = new Array(16).fill(0);
  for (const m of months) {
    const st: WindRoseStats = rose.monthly[m - 1];
    st.sectorHours.forEach((h, i) => (acc[i] += h));
  }
  let best = 0;
  for (let i = 1; i < 16; i++) if (acc[i] > acc[best]) best = i;
  return best * 22.5;
}

export async function runThermal(
  project: Project,
  rose: WindRoseData,
  opts: { cell: number; refHeightM: number },
  onProgress: (pct: number) => void,
): Promise<ThermalResult> {
  const { site, buildings } = project;
  const plans = buildings.filter((b) => b.type === "계획주동");
  if (plans.length === 0) throw new Error("계획주동이 없습니다");
  const sites = sitePolygons(project.siteOverlays);
  const siteO = sites.length > 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pts = siteO ? sites.flat() : plans.flatMap((b) => worldFootprint(b));
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = siteO ? 0 : 30;
  const grid = makeGrid(minX - pad, minY - pad, maxX + pad, maxY + pad, opts.cell);
  const n = grid.nx * grid.ny;
  const target = siteO ? polygonMask(grid, sites) : new Uint8Array(n).fill(1);
  const inside = insideMask(grid, buildings);
  const casters = shadowCasters(buildings);
  const year = project.analysis.date.slice(0, 4);

  const frac = (date: string, a: number, b: number): Float32Array => {
    const samples = sunSamples(date, site.latitude, site.longitude, site.northAngle, a, b - 10, 10);
    const shade = new Float32Array(n);
    const mask = new Uint8Array(n);
    for (const s of samples) {
      shadowMask(grid, casters, s.dir, mask);
      for (let k = 0; k < n; k++) shade[k] += mask[k];
    }
    for (let k = 0; k < n; k++) shade[k] /= samples.length;
    return shade;
  };
  const summerShade = frac(`${year}-08-01`, 720, 960);
  onProgress(25);
  await yieldToEventLoop();
  const winterShade = frac(`${year}-12-21`, 600, 840);
  onProgress(50);
  await yieldToEventLoop();

  const summerDir = seasonPrevailing(rose, [6, 7, 8]);
  const winterDir = seasonPrevailing(rose, [12, 1, 2]);
  const fs = computeWindField(buildings, site, summerDir, Math.max(2, opts.cell), opts.refHeightM);
  onProgress(70);
  await yieldToEventLoop();
  const fw = computeWindField(buildings, site, winterDir, Math.max(2, opts.cell), opts.refHeightM);
  onProgress(90);

  const cls = new Int8Array(n).fill(-1);
  const area: Record<ComfortClass, number> = { both: 0, summer: 0, winter: 0, poor: 0 };
  const order: ComfortClass[] = ["both", "summer", "winter", "poor"];
  const cellA = grid.cell * grid.cell;
  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const k = iy * grid.nx + ix;
      if (!target[k] || inside[k]) continue;
      const x = grid.minX + (ix + 0.5) * grid.cell;
      const y = grid.minY + (iy + 0.5) * grid.cell;
      const vs = sampleWind(fs, x, y);
      const vw = sampleWind(fw, x, y);
      const rs = vs ? Math.hypot(vs.x, vs.y) / fs.windSpeedMs : 1;
      const rw = vw ? Math.hypot(vw.x, vw.y) / fw.windSpeedMs : 1;
      const c = classify(summerScore(summerShade[k], rs), winterScore(1 - winterShade[k], rw));
      cls[k] = order.indexOf(c);
      area[c] += cellA;
    }
  }
  onProgress(100);
  return { grid, cls, area, summerDir, winterDir, scope: siteO ? "site" : "around" };
}

export function createThermalModule(ctx: AnalysisContext): AnalysisModule {
  let result: ThermalResult | null = null;
  let overlay: THREE.Object3D | null = null;
  const order: ComfortClass[] = ["both", "summer", "winter", "poor"];
  const total = () => order.reduce((s, c) => s + result!.area[c], 0);
  return {
    id: "thermal",
    slot: "env",
    title: "외부공간 열쾌적성",
    hint: "여름 그늘·통풍 + 겨울 볕·바람막이로 외부공간 분류 (간이 지표 — 놀이터·쉼터 위치 검토용)",
    settingsHtml: `
      <div class="row"><label for="thermal-cell">격자(m)</label>
        <input type="number" id="thermal-cell" value="3" min="1" max="8" step="1" /></div>
      <p class="hint">풍향은 바람길 섹션의 기상데이터(여름 6~8월·겨울 12~2월 주풍향), 2.5D 기준 높이도 바람길 설정을 씁니다.
      대지경계(SITE_BOUNDARY) 안 외부공간만 봅니다.</p>`,
    async run(onProgress) {
      const loadRose = ctx.extras.loadWindRose as (() => Promise<WindRoseData>) | undefined;
      if (!loadRose) throw new Error("기상데이터를 불러올 수 없습니다");
      const rose = await loadRose();
      const refH = (ctx.extras.windRefHeight as (() => number) | undefined)?.() ?? 20;
      result = await runThermal(ctx.project, rose, { cell: numInput("thermal-cell", 3, 1, 8), refHeightM: refH }, onProgress);
      const r = result;
      const col = order.map((c) => new THREE.Color(COMFORT_COLOR[c]));
      overlay = gridHeatmap(r.grid, (k) => (r.cls[k] >= 0 ? col[r.cls[k]] : null), ctx.elevate(), 0.22, 0.8, ctx.surface?.());
      overlay.name = "thermal";
      ctx.viewer.scene.add(overlay);
      return `외부공간 열쾌적성 — 사계절 쾌적 ${pct(r.area.both, total())} · 불리 ${pct(r.area.poor, total())}`;
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
        order
          .map((c) => `<div class="hint"><span style="color:#${COMFORT_COLOR[c].toString(16).padStart(6, "0")}">■</span> ${COMFORT_LABEL[c]} ${Math.round(r.area[c]).toLocaleString()}㎡ (${pct(r.area[c], total())})</div>`)
          .join("") +
        `<div class="hint">여름 주풍 ${windDirLabel(r.summerDir)} · 겨울 주풍 ${windDirLabel(r.winterDir)}</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "swatches",
          title: "외부공간 열쾌적성 (간이)",
          items: order.map((c) => ({
            color: "#" + COMFORT_COLOR[c].toString(16).padStart(6, "0"),
            label: `${COMFORT_LABEL[c].replace(/\(.*\)/, "")} ${pct(r.area[c], total())}`,
          })),
          note: `여름: 8/1 12~16시 그늘+${windDirLabel(r.summerDir)}풍 · 겨울: 동지 10~14시 볕+${windDirLabel(r.winterDir)}풍 차단`,
        },
      ];
    },
    board() {
      const r = result!;
      return {
        title: "외부공간 열쾌적성",
        value: `사계절 ${pct(r.area.both, total())} · 여름만 ${pct(r.area.summer, total())} · 겨울만 ${pct(r.area.winter, total())} · 불리 ${pct(r.area.poor, total())}`,
        verdict: r.area.poor / Math.max(1, total()) > 0.4 ? "warn" : "info",
      };
    },
    excel() {
      const r = result!;
      return {
        name: "열쾌적성",
        rows: [
          ["외부공간 열쾌적성 (간이 지표 — UTCI·PET 아님)", r.scope === "site" ? "대지경계 안 외부공간" : "계획동 주변 30m"],
          ["여름", `8월 1일 12~16시 그늘 비율 0.6 + 주풍(${windDirLabel(r.summerDir)}) 풍속비 0.4`],
          ["겨울", `동지 10~14시 볕 비율 0.6 + 주풍(${windDirLabel(r.winterDir)}) 차단 0.4`],
          [],
          ["분류", "면적(㎡)", "비율"],
          ...order.map((c) => [COMFORT_LABEL[c], Math.round(r.area[c]), pct(r.area[c], total())]),
        ],
        widths: [24, 50, 10],
      };
    },
  };
}
