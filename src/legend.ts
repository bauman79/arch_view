/**
 * 3D 화면 범례(키맵) — 분석 결과 색이 무슨 뜻인지 화면 구석에 띄운다.
 * 같은 데이터로 DOM 패널과 JPG 캡처용 캔버스 그림을 둘 다 만든다.
 */

export interface LegendSwatch {
  color: string;
  label: string;
}

export type LegendItem =
  | { kind: "swatches"; title: string; items: LegendSwatch[]; note?: string }
  | {
      kind: "gradient";
      title: string;
      /** at: 0~1 위치, color: CSS 색 */
      stops: { at: number; color: string }[];
      ticks: { at: number; label: string }[];
      note?: string;
    };

export function hexCss(hex: number): string {
  return "#" + hex.toString(16).padStart(6, "0");
}

/** [값, 0xRRGGBB] 구간점 → 0~max 정규화 그라데이션 */
export function gradientFromStops(
  stops: [number, number][],
  max: number,
): { at: number; color: string }[] {
  return stops.map(([v, c]) => ({ at: Math.min(1, v / max), color: hexCss(c) }));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function renderLegendPanel(el: HTMLElement, items: LegendItem[]): void {
  el.hidden = items.length === 0;
  el.innerHTML = items
    .map((it) => {
      let body: string;
      if (it.kind === "swatches") {
        body =
          `<div class="lg-sw">` +
          it.items
            .map(
              (s) =>
                `<span><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`,
            )
            .join("") +
          `</div>`;
      } else {
        const grad = it.stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(", ");
        body =
          `<div class="lg-bar" style="background:linear-gradient(to right, ${grad})"></div>` +
          `<div class="lg-ticks">` +
          it.ticks
            .map(
              (t) =>
                `<span style="left:${(t.at * 100).toFixed(1)}%">${escapeHtml(t.label)}</span>`,
            )
            .join("") +
          `</div>`;
      }
      const note = it.note ? `<div class="lg-note">${escapeHtml(it.note)}</div>` : "";
      return `<div class="lg-item"><div class="lg-title">${escapeHtml(it.title)}</div>${body}${note}</div>`;
    })
    .join("");
}

/**
 * 캡처 이미지 좌하단에 범례를 그린다 (DOM 패널과 같은 내용).
 * @param s 배율 — 캡처 픽셀/CSS 픽셀
 */
export function drawLegendsOnCanvas(
  ctx: CanvasRenderingContext2D,
  items: LegendItem[],
  canvasH: number,
  s: number,
): void {
  if (items.length === 0) return;
  const W = 236 * s;
  const pad = 10 * s;
  const font = (px: number, bold = false) =>
    `${bold ? "600 " : ""}${px * s}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  // 높이 먼저 계산
  const heights = items.map((it) => {
    let h = 16; // 제목
    if (it.kind === "swatches") h += Math.ceil(it.items.length / 2) * 16;
    else h += 12 + 16;
    if (it.note) h += 15;
    return h * s;
  });
  const gap = 8 * s;
  const total = heights.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + pad * 2;
  const x0 = 12 * s;
  let y = canvasH - 12 * s - total;
  ctx.save();
  ctx.fillStyle = "rgba(13, 21, 37, 0.86)";
  ctx.strokeStyle = "#1e2d4a";
  ctx.lineWidth = s;
  ctx.beginPath();
  ctx.roundRect(x0, y, W, total, 6 * s);
  ctx.fill();
  ctx.stroke();
  y += pad;
  const ix = x0 + pad;
  const iw = W - pad * 2;
  ctx.textBaseline = "top";
  items.forEach((it, n) => {
    ctx.fillStyle = "#e2e8f0";
    ctx.font = font(12, true);
    ctx.fillText(it.title, ix, y);
    let yy = y + 16 * s;
    ctx.font = font(11);
    if (it.kind === "swatches") {
      it.items.forEach((sw, i) => {
        const cx = ix + (i % 2) * (iw / 2);
        const cy = yy + Math.floor(i / 2) * 16 * s;
        ctx.fillStyle = sw.color;
        ctx.fillRect(cx, cy + 2 * s, 10 * s, 10 * s);
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(sw.label, cx + 14 * s, cy);
      });
      yy += Math.ceil(it.items.length / 2) * 16 * s;
    } else {
      const g = ctx.createLinearGradient(ix, 0, ix + iw, 0);
      for (const st of it.stops) g.addColorStop(st.at, st.color);
      ctx.fillStyle = g;
      ctx.fillRect(ix, yy, iw, 9 * s);
      yy += 12 * s;
      ctx.fillStyle = "#94a3b8";
      ctx.font = font(10);
      for (const t of it.ticks) {
        const w = ctx.measureText(t.label).width;
        const tx = Math.min(ix + iw - w, Math.max(ix, ix + t.at * iw - w / 2));
        ctx.fillText(t.label, tx, yy);
      }
      yy += 16 * s;
    }
    if (it.note) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = font(10);
      ctx.fillText(it.note, ix, yy, iw);
    }
    y += heights[n] + gap;
  });
  ctx.restore();
}
