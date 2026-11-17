import type { BoardEntry, Verdict } from "./analyses";

/**
 * 보고서 — A4 가로 인쇄용 HTML을 만들어 새 창에서 인쇄(→ "PDF로 저장")한다.
 * 브라우저가 시스템 한글 글꼴로 그리므로 PDF 라이브러리·글꼴 내장 없이 글자가 깨지지 않는다.
 */

export interface ReportFigure {
  title: string;
  /** 캡처 이미지 (data URL) */
  image?: string;
  /** 이미지 대신/함께 넣을 HTML (입면 SVG 등) */
  html?: string;
  entry?: BoardEntry | null;
}

export interface ReportData {
  title: string;
  generatedAt: string;
  info: [string, string][];
  summary: BoardEntry[];
  cover?: string;
  figures: ReportFigure[];
}

const VERDICT_LABEL: Record<Verdict, string> = { ok: "적합", warn: "주의", bad: "미달", info: "참고" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function chip(v: Verdict): string {
  return `<span class="chip ${v}">${VERDICT_LABEL[v]}</span>`;
}

const MAX_ITEMS = 18;

export function buildReportHtml(d: ReportData): string {
  const css = `
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; color: #1e293b; }
  .page { page-break-after: always; break-after: page; height: 188mm; display: flex; flex-direction: column; overflow: hidden; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 6px; border-bottom: 2px solid #1e293b; padding-bottom: 4px; display: flex; justify-content: space-between; align-items: baseline; }
  .meta { color: #64748b; font-size: 11px; margin-bottom: 8px; }
  .cover { display: grid; grid-template-columns: 1.6fr 1fr; gap: 10mm; flex: 1; min-height: 0; }
  .cover img, .fig img { width: 100%; height: 100%; object-fit: contain; background: #f8fafc; border: 1px solid #e2e8f0; }
  .imgbox { flex: 1; min-height: 0; display: flex; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  .chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
  .chip.ok { background: #dcfce7; color: #166534; } .chip.bad { background: #fee2e2; color: #991b1b; }
  .chip.warn { background: #fef3c7; color: #92400e; } .chip.info { background: #e0e7ff; color: #3730a3; }
  .fig { display: grid; grid-template-columns: 1fr 70mm; gap: 6mm; flex: 1; min-height: 0; }
  .fig.wide { grid-template-columns: 1fr; }
  .side { font-size: 11px; overflow: hidden; }
  .side .val { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .side li { margin: 1px 0; } .side li.bad { color: #b91c1c; } .side li.warn { color: #b45309; }
  .side ul { padding-left: 14px; margin: 4px 0; }
  .rp-svg svg { width: 100%; height: auto; max-height: 70mm; }
  .note { font-size: 9px; color: #94a3b8; margin-top: 4px; }
  @media screen { body { background: #e2e8f0; } .page { background: #fff; width: 277mm; margin: 8mm auto; padding: 8mm; height: auto; min-height: 188mm; box-shadow: 0 2px 8px rgba(0,0,0,.15); } .imgbox { height: 140mm; } }
  `;
  const info = d.info.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
  const summary = d.summary
    .map((e) => `<tr><td>${esc(e.title)}</td><td>${esc(e.value)}</td><td>${chip(e.verdict)}</td></tr>`)
    .join("");
  let html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>${css}</style></head><body>`;
  html +=
    `<section class="page"><h1>${esc(d.title)}</h1><div class="meta">작성 ${esc(d.generatedAt)} · arch_view 배치 검토 (참고자료 — 인허가용 공식 근거 아님)</div>` +
    `<div class="cover"><div class="imgbox">${d.cover ? `<img src="${d.cover}">` : ""}</div>` +
    `<div><table>${info}</table><h2 style="margin-top:10px">검토·분석 결과 요약</h2>` +
    `<table><tr><th>항목</th><th>결과</th><th>판정</th></tr>${summary || `<tr><td colspan="3">실행한 검토가 없습니다</td></tr>`}</table></div></div></section>`;
  for (const f of d.figures) {
    const e = f.entry;
    const items = e?.items ?? [];
    const shown = items.slice(0, MAX_ITEMS);
    const side = e
      ? `<div class="side"><div class="val">${esc(e.value)} ${chip(e.verdict)}</div>` +
        (shown.length
          ? `<ul>${shown.map((i) => `<li class="${i.verdict ?? ""}">${esc(i.label)}</li>`).join("")}</ul>` +
            (items.length > MAX_ITEMS ? `<div class="note">… 외 ${items.length - MAX_ITEMS}건 (엑셀 참고)</div>` : "")
          : "") +
        `</div>`
      : "";
    const body = f.image
      ? `<div class="fig${side ? "" : " wide"}"><div class="imgbox"><img src="${f.image}"></div>${side}</div>`
      : `<div class="fig wide"><div>${f.html ?? ""}</div></div>${side ? `<div>${side}</div>` : ""}`;
    html += `<section class="page"><h2><span>${esc(f.title)}</span><span class="meta">${esc(d.title)}</span></h2>${body}${f.image && f.html ? f.html : ""}</section>`;
  }
  html += `</body></html>`;
  return html;
}
