import type { BoardEntry, Verdict } from "./analyses";
import type * as THREE from "three";

/**
 * 통합 결과판 — 오른쪽 패널에 실행한 모든 검토·분석의 핵심 수치를 모아 보여준다.
 * 위반·미달 항목은 눌러서 3D 화면의 해당 위치로 이동할 수 있다.
 */

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: "적합",
  warn: "주의",
  bad: "미달",
  info: "참고",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const MAX_ITEMS = 30;

export function renderResultBoard(
  el: HTMLElement,
  entries: BoardEntry[],
  flyTo: (p: THREE.Vector3) => void,
): void {
  const section = el.closest("section") as HTMLElement | null;
  if (section) section.hidden = entries.length === 0;
  el.replaceChildren();
  for (const e of entries) {
    const box = document.createElement("div");
    box.className = `rb-entry rb-${e.verdict}`;
    const head = document.createElement("div");
    head.className = "rb-head";
    head.innerHTML =
      `<span class="rb-title">${escapeHtml(e.title)}</span>` +
      `<span class="rb-chip">${VERDICT_LABEL[e.verdict]}</span>`;
    box.append(head);
    const val = document.createElement("div");
    val.className = "rb-value";
    val.textContent = e.value;
    box.append(val);
    const items = e.items ?? [];
    if (items.length > 0) {
      const det = document.createElement("details");
      det.className = "rb-items";
      const bad = items.filter((i) => i.verdict === "bad" || i.verdict === "warn").length;
      det.innerHTML = `<summary>${bad > 0 ? `확인 필요 ${bad}건` : `세부 ${items.length}건`}</summary>`;
      const list = document.createElement("div");
      for (const it of items.slice(0, MAX_ITEMS)) {
        const b = document.createElement("button");
        b.className = `rb-item rb-${it.verdict ?? "info"}`;
        b.textContent = it.label;
        if (it.at) {
          const at = it.at;
          b.title = "눌러서 3D 화면에서 위치 보기";
          b.addEventListener("click", () => flyTo(at));
        } else b.disabled = true;
        list.append(b);
      }
      if (items.length > MAX_ITEMS) {
        const more = document.createElement("p");
        more.className = "hint";
        more.textContent = `… 외 ${items.length - MAX_ITEMS}건 (엑셀에서 전체 확인)`;
        list.append(more);
      }
      det.append(list);
      box.append(det);
    }
    el.append(box);
  }
}
