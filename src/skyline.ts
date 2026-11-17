import { worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule } from "./analyses";
import { pct } from "./analyses";
import { buildingHeight, type Point2, type Project } from "./types";

/**
 * 스카이라인·입면 분석 — 동서남북 네 방향에서 본 정투영 입면(건물을 직육면체 실루엣으로)과
 * 지표:
 *  - 입면 차폐율: 계획주동 실루엣이 가리는 폭 / 대지 폭(그 방향에서 본 대지경계 폭)
 *  - 높이: 최고·최저·평균·표준편차 (각 동 G.L. 기준)
 *  - 스카이라인 변화: 계획동 윤곽에서 3m 넘게 높이가 바뀌는 지점 수 (100m당)
 * 입면 그림은 SVG로 띄우고 저장할 수 있다.
 */

export type Side = "south" | "north" | "east" | "west";
export const SIDE_LABEL: Record<Side, string> = { south: "남측", north: "북측", east: "동측", west: "서측" };
const SIDES: Side[] = ["south", "east", "north", "west"];

export interface Silhouette {
  name: string;
  plan: boolean;
  u0: number;
  u1: number;
  base: number;
  top: number;
  depth: number;
}

export interface ElevationResult {
  side: Side;
  shapes: Silhouette[];
  siteU: [number, number] | null;
  coverRatio: number;
  coveredM: number;
  widthM: number;
  maxH: number;
  minH: number;
  avgH: number;
  stdH: number;
  changesPer100m: number;
}

/** 관찰자가 바라보는 방향(도면 좌표) — 남측 입면은 남쪽에 서서 북쪽을 본다 */
export function facing(side: Side, northAngleDeg: number): Point2 {
  const th = (northAngleDeg * Math.PI) / 180;
  const N = { x: -Math.sin(th), y: Math.cos(th) };
  const E = { x: N.y, y: -N.x };
  return side === "south" ? N : side === "north" ? { x: -N.x, y: -N.y } : side === "east" ? { x: -E.x, y: -E.y } : E;
}

/** 구간 합집합 길이 */
export function unionLength(iv: [number, number][]): number {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0, cs = -Infinity, ce = -Infinity;
  for (const [a, b] of s) {
    if (a > ce) {
      if (ce > cs) total += ce - cs;
      cs = a;
      ce = b;
    } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

export function computeElevation(project: Project, side: Side): ElevationResult {
  const f = facing(side, project.site.northAngle);
  const right = { x: f.y, y: -f.x };
  const shapes: Silhouette[] = [];
  for (const b of project.buildings) {
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    let u0 = Infinity, u1 = -Infinity, dsum = 0;
    for (const p of fp) {
      const u = p.x * right.x + p.y * right.y;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      dsum += p.x * f.x + p.y * f.y;
    }
    const gl = b.terrainElevation ?? 0;
    shapes.push({ name: b.name, plan: b.type === "계획주동", u0, u1, base: gl, top: gl + buildingHeight(b), depth: dsum / fp.length });
  }
  const plans = shapes.filter((s) => s.plan);
  const sitePts = project.siteOverlays.filter((o) => o.layer === "SITE_BOUNDARY").flatMap((o) => o.points);
  let siteU: [number, number] | null = null;
  if (sitePts.length >= 2) {
    const us = sitePts.map((p) => p.x * right.x + p.y * right.y);
    siteU = [Math.min(...us), Math.max(...us)];
  }
  const widthM = siteU ? siteU[1] - siteU[0] : plans.length ? Math.max(...plans.map((s) => s.u1)) - Math.min(...plans.map((s) => s.u0)) : 0;
  const coveredM = unionLength(plans.map((s) => [s.u0, s.u1]));
  const hs = plans.map((s) => s.top - s.base);
  const avgH = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 0;
  const stdH = hs.length ? Math.sqrt(hs.reduce((a, h) => a + (h - avgH) ** 2, 0) / hs.length) : 0;
  // 계획동 윤곽(위쪽 외곽선)에서 3m 넘는 높이 변화 수
  const xs = [...new Set(plans.flatMap((s) => [s.u0, s.u1]))].sort((a, b) => a - b);
  let changes = 0;
  let prev = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const m = (xs[i] + xs[i + 1]) / 2;
    const h = Math.max(0, ...plans.filter((s) => s.u0 <= m && s.u1 >= m).map((s) => s.top - s.base));
    if (i > 0 && Math.abs(h - prev) > 3) changes++;
    prev = h;
  }
  return {
    side,
    shapes,
    siteU,
    coverRatio: widthM > 0 ? Math.min(1, coveredM / widthM) : 0,
    coveredM,
    widthM,
    maxH: hs.length ? Math.max(...hs) : 0,
    minH: hs.length ? Math.min(...hs) : 0,
    avgH,
    stdH,
    changesPer100m: widthM > 0 ? (changes / widthM) * 100 : 0,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 입면 SVG (축척 그대로, 1m = scale px) */
export function elevationSvg(r: ElevationResult, showAdj: boolean): string {
  const shapes = r.shapes.filter((s) => s.plan || showAdj);
  const plans = shapes.filter((s) => s.plan);
  const focus = plans.length ? plans : shapes;
  const pad = 30;
  let u0 = Math.min(...focus.map((s) => s.u0)), u1 = Math.max(...focus.map((s) => s.u1));
  if (r.siteU) {
    u0 = Math.min(u0, r.siteU[0]);
    u1 = Math.max(u1, r.siteU[1]);
  }
  u0 -= pad;
  u1 += pad;
  const vis = shapes.filter((s) => s.u1 > u0 && s.u0 < u1);
  const z0 = Math.min(...vis.map((s) => s.base));
  const z1 = Math.max(...vis.map((s) => s.top), 10) + 15;
  const W = 860;
  const sc = W / (u1 - u0);
  const H = Math.max(160, (z1 - z0) * sc);
  const X = (u: number) => (u - u0) * sc;
  const Y = (z: number) => H - (z - z0) * sc;
  // 먼 것부터 그려 가까운 동이 앞에 오게
  const ordered = [...vis].sort((a, b) => b.depth - a.depth);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 24}" width="100%" style="background:#f8fafc">`;
  svg += `<line x1="0" y1="${Y(z0)}" x2="${W}" y2="${Y(z0)}" stroke="#64748b" stroke-width="1"/>`;
  if (r.siteU) {
    svg += `<rect x="${X(r.siteU[0])}" y="${Y(z0)}" width="${(r.siteU[1] - r.siteU[0]) * sc}" height="4" fill="#ef4444" opacity="0.6"/>`;
  }
  for (const s of ordered) {
    svg +=
      `<rect x="${X(s.u0).toFixed(1)}" y="${Y(s.top).toFixed(1)}" width="${((s.u1 - s.u0) * sc).toFixed(1)}" height="${((s.top - s.base) * sc).toFixed(1)}" ` +
      `fill="${s.plan ? "#e0a030" : "#cbd5e1"}" stroke="${s.plan ? "#92400e" : "#64748b"}" stroke-width="0.8"><title>${esc(s.name)} ${(s.top - s.base).toFixed(1)}m</title></rect>`;
  }
  // 최고 높이선
  if (plans.length) {
    const top = Math.max(...plans.map((s) => s.top));
    svg += `<line x1="0" y1="${Y(top)}" x2="${W}" y2="${Y(top)}" stroke="#dc2626" stroke-dasharray="4 3" stroke-width="0.8"/>`;
    svg += `<text x="4" y="${Y(top) - 3}" font-size="11" fill="#dc2626">최고 ${r.maxH.toFixed(1)}m</text>`;
  }
  // 축척 막대 50m
  const bar = 50 * sc;
  svg += `<line x1="${W - bar - 10}" y1="${H + 14}" x2="${W - 10}" y2="${H + 14}" stroke="#334155" stroke-width="2"/>`;
  svg += `<text x="${W - bar - 10}" y="${H + 10}" font-size="10" fill="#334155">50m</text>`;
  svg += `<text x="4" y="${H + 18}" font-size="11" fill="#334155">${SIDE_LABEL[r.side]} 입면 · 주황=계획주동 · 회색=인접건물 · 빨간 띠=대지 폭</text>`;
  svg += `</svg>`;
  return svg;
}

let modalEl: HTMLElement | null = null;

function showElevationModal(results: ElevationResult[], initial: Side): void {
  modalEl?.remove();
  const m = document.createElement("div");
  m.className = "modal-overlay";
  m.innerHTML = `<div class="modal-box" style="max-width:940px;width:94vw">
    <h2>스카이라인·입면</h2>
    <div class="row" id="elev-tabs"></div>
    <div class="row"><label><input type="checkbox" id="elev-adj" checked /> 인접건물 표시</label></div>
    <div id="elev-svg" style="overflow:auto;max-height:60vh"></div>
    <table class="elev-table" style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse"></table>
    <div class="row"><button class="btn" id="elev-save">SVG 저장</button><button class="btn primary" id="elev-close">닫기</button></div>
  </div>`;
  document.body.append(m);
  modalEl = m;
  let cur = initial;
  const svgBox = m.querySelector("#elev-svg") as HTMLElement;
  const adj = m.querySelector("#elev-adj") as HTMLInputElement;
  const draw = () => {
    const r = results.find((x) => x.side === cur)!;
    svgBox.innerHTML = elevationSvg(r, adj.checked);
    for (const b of m.querySelectorAll<HTMLButtonElement>("#elev-tabs button")) b.classList.toggle("primary", b.dataset.side === cur);
  };
  const tabs = m.querySelector("#elev-tabs") as HTMLElement;
  for (const r of results) {
    const b = document.createElement("button");
    b.className = "btn mini";
    b.dataset.side = r.side;
    b.textContent = `${SIDE_LABEL[r.side]} 입면`;
    b.addEventListener("click", () => {
      cur = r.side;
      draw();
    });
    tabs.append(b);
  }
  (m.querySelector(".elev-table") as HTMLElement).innerHTML =
    `<tr><th align="left">방향</th><th>입면 차폐율</th><th>가린 폭 / 대지 폭</th><th>최고·최저·평균</th><th>높이 편차</th><th>변화(100m당)</th></tr>` +
    results
      .map(
        (r) =>
          `<tr><td>${SIDE_LABEL[r.side]}</td><td align="center"><b>${pct(r.coverRatio, 1)}</b></td>` +
          `<td align="center">${r.coveredM.toFixed(0)} / ${r.widthM.toFixed(0)}m</td>` +
          `<td align="center">${r.maxH.toFixed(0)} · ${r.minH.toFixed(0)} · ${r.avgH.toFixed(0)}m</td>` +
          `<td align="center">${r.stdH.toFixed(1)}m</td><td align="center">${r.changesPer100m.toFixed(1)}</td></tr>`,
      )
      .join("");
  adj.addEventListener("change", draw);
  m.querySelector("#elev-close")!.addEventListener("click", () => m.remove());
  m.addEventListener("click", (e) => {
    if (e.target === m) m.remove();
  });
  m.querySelector("#elev-save")!.addEventListener("click", () => {
    const blob = new Blob([svgBox.innerHTML], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${SIDE_LABEL[cur]}_입면.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  draw();
}

export function createSkylineModule(ctx: AnalysisContext): AnalysisModule {
  let results: ElevationResult[] | null = null;
  return {
    id: "skyline",
    slot: "env",
    title: "스카이라인·입면",
    hint: "동서남북 입면 실루엣과 입면 차폐율·높이 변화 — 실행하면 입면 창이 열립니다",
    runLabel: "입면 분석",
    extraButtons: [
      {
        id: "skyline-open",
        label: "입면 다시 보기",
        onClick: () => {
          if (results) showElevationModal(results, "south");
          else ctx.setStatus("먼저 입면 분석을 실행하세요.");
        },
      },
    ],
    async run() {
      if (!ctx.project.buildings.some((b) => b.type === "계획주동")) throw new Error("계획주동이 없습니다");
      results = SIDES.map((s) => computeElevation(ctx.project, s));
      showElevationModal(results, "south");
      const worst = [...results].sort((a, b) => b.coverRatio - a.coverRatio)[0];
      return `입면 분석 — 차폐율 최대 ${SIDE_LABEL[worst.side]} ${pct(worst.coverRatio, 1)}`;
    },
    clear() {
      results = null;
    },
    hasResult: () => results !== null,
    summaryHtml() {
      return results!
        .map((r) => `<div class="hint">${SIDE_LABEL[r.side]} 입면 차폐율 <b>${pct(r.coverRatio, 1)}</b> · 최고 ${r.maxH.toFixed(0)}m</div>`)
        .join("");
    },
    legends: () => [],
    board() {
      const rs = results!;
      return {
        title: "스카이라인·입면",
        value: rs.map((r) => `${SIDE_LABEL[r.side]} ${pct(r.coverRatio, 1)}`).join(" · ") + " (입면 차폐율)",
        verdict: "info",
      };
    },
    excel() {
      return {
        name: "스카이라인·입면",
        rows: [
          ["스카이라인·입면", "입면 차폐율 = 계획주동이 가린 폭 / 대지 폭 (정투영)"],
          [],
          ["방향", "입면 차폐율", "가린 폭(m)", "대지 폭(m)", "최고(m)", "최저(m)", "평균(m)", "높이 편차(m)", "변화(100m당)"],
          ...results!.map((r) => [
            SIDE_LABEL[r.side],
            pct(r.coverRatio, 1),
            Math.round(r.coveredM),
            Math.round(r.widthM),
            Math.round(r.maxH * 10) / 10,
            Math.round(r.minH * 10) / 10,
            Math.round(r.avgH * 10) / 10,
            Math.round(r.stdH * 10) / 10,
            Math.round(r.changesPer100m * 10) / 10,
          ]),
        ],
        widths: [10, 12, 10, 10, 9, 9, 9, 12, 12],
      };
    },
  };
}
