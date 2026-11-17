import * as THREE from "three";
import type { DrapeSurface } from "./drape";
import type { LegendItem } from "./legend";
import type { Point2, Project } from "./types";
import type { Viewer } from "./viewer";

/**
 * 추가 분석 모듈 공통 틀 — 왼쪽 패널 섹션(실행·지우기·세부 설정·요약), 화면 범례,
 * 통합 결과판, 엑셀 시트, 배치 변경 시 무효화를 한 규약으로 묶는다.
 * 각 분석은 계산(순수 함수)과 표시(오버레이)만 자기 파일에 두고 여기 등록한다.
 */

export type ElevateFn = ((x: number, y: number) => number) | undefined;

export interface AnalysisContext {
  project: Project;
  viewer: Viewer;
  /** (x,y DXF) → 지형 고도. 지형이 없으면 undefined */
  elevate(): ElevateFn;
  /** 지형 표면 삼각형 — 바닥 히트맵을 지형에 정확히 얹을 때. 지형 없으면 undefined */
  surface?(): DrapeSurface | undefined;
  setStatus(msg: string): void;
  /** 결과가 생기거나 지워졌을 때 — 범례·결과판 갱신 */
  changed(): void;
  /** 3D 화면을 이 점(three 좌표)으로 이동 */
  flyTo(p: THREE.Vector3, dist?: number): void;
  /** 다른 분석 결과 참조용 (예: 열쾌적성이 LBM 결과를 쓸 때) */
  extras: Record<string, unknown>;
  /** DXF 원점 보정값 — 결과를 DXF로 내보낼 때 원본 좌표 복원용 */
  sceneOrigin(): { x: number; y: number } | null;
  /**
   * 3D 화면에서 지면(지형) 위 점을 n개 찍게 한다 — Esc로 취소하면 null.
   * onPoint는 점을 찍을 때마다 불린다(첫 점 표시 등).
   */
  pickGroundPoints?(n: number, prompt: string, onPoint?: (p: Point2, i: number) => void): Promise<Point2[] | null>;
  /** 파일 저장(바탕화면 저장 창 → 공유/다운로드 폴백) */
  saveFile(blob: Blob, filename: string, description: string, accept: Record<string, string[]>): Promise<void>;
}

export type Verdict = "ok" | "warn" | "bad" | "info";

export interface BoardItem {
  label: string;
  verdict?: Verdict;
  /** 누르면 이동할 위치 (three 좌표) */
  at?: THREE.Vector3;
}

export interface BoardEntry {
  title: string;
  /** 대표 수치 한 줄 */
  value: string;
  verdict: Verdict;
  /** 동별·지점별 세부 (위반 위치 이동용) */
  items?: BoardItem[];
}

export interface ExcelSheet {
  name: string;
  rows: (string | number | null)[][];
  widths?: number[];
}

export interface AnalysisModule {
  id: string;
  /** 왼쪽 패널 묶음 — 해당 위치의 슬롯에 들어간다 */
  slot: "sun" | "env";
  title: string;
  hint: string;
  /** 세부 설정 HTML (input id는 모듈 id로 접두) — 없으면 생략 */
  settingsHtml?: string;
  /** 실행 버튼 라벨 (기본 "분석 실행") */
  runLabel?: string;
  run(onProgress: (pct: number) => void): Promise<string>;
  clear(): void;
  hasResult(): boolean;
  /** 왼쪽 패널 요약 HTML */
  summaryHtml(): string;
  legends(): LegendItem[];
  board(): BoardEntry | null;
  excel(): ExcelSheet | null;
  /** 추가 버튼 (예: DXF 내보내기, 입면 보기) */
  extraButtons?: { id: string; label: string; onClick: () => void }[];
  /** 실행 버튼 위에 넣을 본문 HTML (예: 차양 목록) — onMount에서 이벤트를 단다 */
  bodyHtml?: string;
  onMount?(): void;
  /** 보고서 그림 캡처용 — 결과 표시만 켜고 끈다 */
  setVisible?(on: boolean): void;
  /** 보고서에 그림 대신(또는 함께) 넣을 HTML (예: 입면 SVG) */
  reportHtml?(): string;
  /** .view 열기·배치안 불러오기·DXF 불러오기 뒤 — 프로젝트 데이터로 다시 그릴 때 */
  onProjectLoaded?(): void;
}

const modules: AnalysisModule[] = [];
let ctxRef: AnalysisContext | null = null;
const running = new Set<string>();

export function getAnalyses(): AnalysisModule[] {
  return modules;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

function refreshSummary(m: AnalysisModule): void {
  const box = document.getElementById(`${m.id}-summary`);
  if (box) box.innerHTML = m.hasResult() ? m.summaryHtml() : "";
}

/** 모듈 등록 + 왼쪽 패널 섹션 생성 */
export function registerAnalysis(m: AnalysisModule): void {
  modules.push(m);
  const slot = document.querySelector<HTMLElement>(`[data-analysis-slot="${m.slot}"]`);
  if (!slot) return;
  const det = el("details", { class: "lp-acc", id: `${m.id}-section` });
  det.append(el("summary", {}, m.title));
  det.append(el("p", { class: "hint" }, m.hint));
  if (m.bodyHtml) {
    const body = el("div", { class: "an-body" });
    body.innerHTML = m.bodyHtml;
    det.append(body);
  }
  const row = el("div", { class: "row" });
  const runBtn = el("button", { class: "btn primary", id: `run-${m.id}` }, m.runLabel ?? "분석 실행");
  const clearBtn = el("button", { class: "btn mini", id: `clear-${m.id}` }, "지우기");
  row.append(runBtn, clearBtn);
  det.append(row);
  if (m.extraButtons?.length) {
    const r2 = el("div", { class: "row" });
    for (const b of m.extraButtons) {
      const btn = el("button", { class: "btn mini", id: b.id }, b.label);
      btn.addEventListener("click", b.onClick);
      r2.append(btn);
    }
    det.append(r2);
  }
  det.append(el("div", { id: `${m.id}-summary`, class: "an-summary" }));
  if (m.settingsHtml) {
    const sub = el("details", { class: "lp-sub" });
    sub.append(el("summary", {}, "세부 설정"));
    const body = el("div");
    body.innerHTML = m.settingsHtml;
    sub.append(body);
    det.append(sub);
  }
  slot.append(det);
  m.onMount?.();

  runBtn.addEventListener("click", async () => {
    const ctx = ctxRef;
    if (!ctx || running.has(m.id)) return;
    if (ctx.project.buildings.length === 0) {
      ctx.setStatus("먼저 DXF를 불러오세요.");
      return;
    }
    running.add(m.id);
    runBtn.disabled = true;
    const label = runBtn.textContent;
    try {
      m.clear();
      ctx.setStatus(`${m.title} 분석 중…`);
      const msg = await m.run((pct) => {
        runBtn.textContent = `${Math.round(pct)}%`;
        ctx.setStatus(`${m.title} 분석 중… ${Math.round(pct)}%`);
      });
      ctx.setStatus(msg);
    } catch (err) {
      m.clear();
      ctx.setStatus(`${m.title} 실패: ${(err as Error).message}`);
      console.error(err);
    } finally {
      running.delete(m.id);
      runBtn.disabled = false;
      runBtn.textContent = label;
      refreshSummary(m);
      ctx.changed();
    }
  });
  clearBtn.addEventListener("click", () => {
    m.clear();
    refreshSummary(m);
    ctxRef?.changed();
    ctxRef?.setStatus(`${m.title} 결과를 지웠습니다.`);
  });
}

export function initAnalyses(ctx: AnalysisContext): void {
  ctxRef = ctx;
}

/** 배치가 바뀌면 모든 추가 분석 결과를 지운다 */
export function invalidateAnalyses(note: string): void {
  for (const m of modules) {
    if (!m.hasResult()) continue;
    m.clear();
    const box = document.getElementById(`${m.id}-summary`);
    if (box) box.innerHTML = `<p class="hint">${note}</p>`;
  }
}

export function notifyProjectLoaded(): void {
  for (const m of modules) m.onProjectLoaded?.();
}

export function analysisLegends(): LegendItem[] {
  return modules.filter((m) => m.hasResult()).flatMap((m) => m.legends());
}

export function analysisBoard(): BoardEntry[] {
  return modules
    .filter((m) => m.hasResult())
    .map((m) => m.board())
    .filter((e): e is BoardEntry => e !== null);
}

export function analysisSheets(): ExcelSheet[] {
  return modules
    .filter((m) => m.hasResult())
    .map((m) => m.excel())
    .filter((s): s is ExcelSheet => s !== null);
}

/** 입력값 읽기 헬퍼 — 세부 설정 input */
export function numInput(id: string, fallback: number, min = -Infinity, max = Infinity): number {
  const v = parseFloat((document.getElementById(id) as HTMLInputElement | null)?.value ?? "");
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function selInput(id: string, fallback: string): string {
  return (document.getElementById(id) as HTMLSelectElement | null)?.value ?? fallback;
}

export function chkInput(id: string, fallback: boolean): boolean {
  const e = document.getElementById(id) as HTMLInputElement | null;
  return e ? e.checked : fallback;
}

/** 그룹 안 메시·선 정리 */
export function disposeObject(obj: THREE.Object3D | null): void {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o) => {
    const anyO = o as THREE.Mesh;
    if (anyO.geometry) anyO.geometry.dispose();
    const mat = anyO.material as THREE.Material | THREE.Material[] | undefined;
    const disp = (x: THREE.Material) => {
      (x as THREE.SpriteMaterial).map?.dispose();
      x.dispose();
    };
    if (Array.isArray(mat)) mat.forEach(disp);
    else if (mat) disp(mat);
  });
}

/** 3D 문자 라벨 (캔버스 텍스처 스프라이트) — 높이 h(m) */
export function textSprite(text: string, color = "#ffffff", h = 6, bg = "rgba(13,21,37,0.75)"): THREE.Sprite {
  const fs = 48;
  const c = document.createElement("canvas");
  const ctx2 = c.getContext("2d")!;
  ctx2.font = `600 ${fs}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  const w = Math.ceil(ctx2.measureText(text).width) + 24;
  c.width = w;
  c.height = fs + 20;
  ctx2.font = `600 ${fs}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  ctx2.fillStyle = bg;
  ctx2.beginPath();
  ctx2.roundRect(0, 0, w, c.height, 12);
  ctx2.fill();
  ctx2.fillStyle = color;
  ctx2.textBaseline = "middle";
  ctx2.fillText(text, 12, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((h * w) / c.height, h, 1);
  sp.renderOrder = 10;
  return sp;
}

export function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}
