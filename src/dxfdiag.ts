/**
 * DXF 불러오기 진단표 — 레이어별 엔티티 수를 세어 규약(data/DXF_RULES.md)상 무엇으로
 * 인식됐는지, 인식 못 한 레이어는 무엇인지 한 장으로 보여준다. 도면 정리 시간을 줄이는 용도.
 */

export interface LayerStat {
  layer: string;
  count: number;
  types: Record<string, number>;
  category: string;
}

export interface DxfDiagnosis {
  layers: LayerStat[];
  totalEntities: number;
}

const RULES: [RegExp, string][] = [
  [/^PLAN_WIN$/, "창 표시 (계획주동)"],
  [/^ADJ_WIN$/, "창 표시 (인접건물)"],
  [/^ADJ_BOUNDARY$/, "인접대지경계"],
  [/^(PLAN_)?CORE$/, "코어 (세대 유니트와 합쳐 주동)"],
  [/^_/, "범례·안내 (불러오지 않음)"],
  [/^PLAN_/, "계획주동 외곽선"],
  [/^ADJ_/, "인접건물 외곽선"],
  [/^BLDG_FLOORS$/, "층수 문자"],
  [/^BLDG_USE$/, "용도 문자 (유치원·학교·교회)"],
  [/^BLDG_NAME$/, "동 이름 문자"],
  [/^UNIT_/, "세대 유니트 (평형별)"],
  [/^SITE_BOUNDARY$/, "대지경계"],
  [/^ROAD_CL$/, "도로중심선"],
  [/^ROAD_AREA$/, "도로 영역"],
  [/^PARK_BOUNDARY$/, "공원경계"],
  [/^PARCEL_SITE$/, "필지선 (대상지 내)"],
  [/^PARCEL/, "필지선"],
  [/^CONTOUR/, "등고선"],
];

export function classifyLayer(layer: string): string {
  const u = layer.toUpperCase();
  for (const [re, label] of RULES) if (re.test(u)) return label;
  return "미인식 (불러오지 않음)";
}

/** ENTITIES 섹션의 (0 엔티티종류 … 8 레이어) 쌍을 센다 — 파서와 독립적인 가벼운 스캔 */
export function diagnoseDxfText(text: string): DxfDiagnosis {
  const lines = text.split(/\r?\n/);
  const stats = new Map<string, LayerStat>();
  let inEntities = false;
  let curType: string | null = null;
  let total = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const val = lines[i + 1].trim();
    if (code === "2" && (val === "ENTITIES" || val === "BLOCKS")) {
      inEntities = val === "ENTITIES";
      continue;
    }
    if (code === "0") {
      if (val === "ENDSEC") inEntities = false;
      curType = inEntities && val !== "SEQEND" && val !== "VERTEX" ? val : null;
      continue;
    }
    if (code === "8" && curType) {
      const s = stats.get(val) ?? { layer: val, count: 0, types: {}, category: classifyLayer(val) };
      s.count++;
      s.types[curType] = (s.types[curType] ?? 0) + 1;
      stats.set(val, s);
      total++;
      curType = null;
    }
  }
  const layers = [...stats.values()].sort((a, b) => {
    const ua = a.category.startsWith("미인식") ? 1 : 0;
    const ub = b.category.startsWith("미인식") ? 1 : 0;
    return ua - ub || a.category.localeCompare(b.category) || b.count - a.count;
  });
  return { layers, totalEntities: total };
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export interface LoadSummary {
  fileName: string;
  plans: number;
  adj: number;
  planWinMatched: number;
  adjWinMatched: number;
  floorsFromText: number;
  overlays: number;
  contourPoints: number;
  warnings: string[];
}

export function diagnosisHtml(d: DxfDiagnosis, s: LoadSummary): string {
  const winLines = (cat: string) => d.layers.filter((l) => l.category === cat).reduce((a, l) => a + l.count, 0);
  const planWin = winLines("창 표시 (계획주동)");
  const adjWin = winLines("창 표시 (인접건물)");
  const unknown = d.layers.filter((l) => l.category.startsWith("미인식"));
  const winOk = !s.warnings.some((w) => w.includes("PLAN_WIN") || w.includes("ADJ_WIN"));
  const checks: [boolean, string][] = [
    [s.plans > 0, `계획주동 ${s.plans}동`],
    [true, `인접건물 ${s.adj}동 (층수 문자 반영 ${s.floorsFromText}동)`],
    [winOk, `창 표시 — 계획주동 선 ${planWin}개 → 벽에 맞은 창 ${s.planWinMatched}개 · 인접건물 선 ${adjWin}개 → ${s.adjWinMatched}개` + (winOk ? "" : " (벽에 안 맞은 선 있음 — 알림 참고)")],
    [d.layers.some((l) => l.category === "대지경계"), "대지경계(SITE_BOUNDARY)"],
    [d.layers.some((l) => l.category === "도로중심선" || l.category === "도로 영역"), "도로(ROAD_CL·ROAD_AREA) — 일조권 도로 접면·소음·그늘보행권에 필요"],
    [s.contourPoints > 0 || !d.layers.some((l) => l.category === "등고선"), `등고선 점 ${s.contourPoints}개`],
    [unknown.length === 0, `미인식 레이어 ${unknown.length}개 (불러오지 않음)`],
  ];
  let html =
    `<p class="hint">${esc(s.fileName)} — 엔티티 ${d.totalEntities.toLocaleString()}개 · 레이어 ${d.layers.length}개</p>` +
    `<ul class="diag-checks">` +
    checks.map(([ok, t]) => `<li class="${ok ? "ok" : "bad"}">${ok ? "✓" : "!"} ${esc(t)}</li>`).join("") +
    `</ul>`;
  if (s.warnings.length) {
    html += `<details open><summary>불러오기 알림 ${s.warnings.length}건</summary><ul class="diag-warn">${s.warnings
      .map((w) => `<li>${esc(w)}</li>`)
      .join("")}</ul></details>`;
  }
  html +=
    `<table class="diag-table"><tr><th>레이어</th><th>인식</th><th>개수</th><th>종류</th></tr>` +
    d.layers
      .map(
        (l) =>
          `<tr class="${l.category.startsWith("미인식") ? "unk" : ""}"><td>${esc(l.layer)}</td><td>${esc(l.category)}</td>` +
          `<td align="right">${l.count}</td><td>${esc(Object.entries(l.types).map(([k, v]) => `${k} ${v}`).join(", "))}</td></tr>`,
      )
      .join("") +
    `</table>`;
  return html;
}
