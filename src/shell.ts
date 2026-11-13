/**
 * 반응형 셸 — 태블릿·좁은 화면에서 좌/우 패널을 드로어로 전환하고,
 * 툴바 "파일" 드롭다운과 상태바 상세 알림 모달을 배선한다.
 *
 * 3D 캔버스·분석 로직과는 무관한 순수 UI 계층이라 main.ts에서 initShell() 한 번만 호출한다.
 * 터치 기기에는 hover가 없으므로, hover 툴팁(title)으로만 전달되던 DXF 경고를
 * 탭 가능한 "자세히" 버튼 + 모달로도 노출하는 것이 이 모듈의 핵심 역할 중 하나다.
 */

/** 이 폭 이하에서는 좌/우 패널이 캔버스를 덮는 드로어로 동작한다 (iPad 세로 810px 포함) */
const DRAWER_QUERY = "(max-width: 1100px)";

type Side = "left" | "right";

const PANEL_ID: Record<Side, string> = {
  left: "left-panel",
  right: "right-panel",
};

const TOGGLE_ID: Record<Side, string> = {
  left: "toggle-left-panel",
  right: "toggle-right-panel",
};

let drawerMedia: MediaQueryList | null = null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** 현재 드로어 모드인지 — 데스크톱 3열에서는 false */
export function isDrawerMode(): boolean {
  return drawerMedia ? drawerMedia.matches : false;
}

function panel(side: Side): HTMLElement | null {
  return el(PANEL_ID[side]);
}

function setToggleState(side: Side, open: boolean): void {
  const btn = el<HTMLButtonElement>(TOGGLE_ID[side]);
  if (!btn) return;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.classList.toggle("active", open);
  // 열어서 확인했으면 "새 결과 있음" 강조는 해제
  if (open) btn.classList.remove("attention");
}

function syncScrim(): void {
  const main = el("main");
  if (!main) return;
  const anyOpen =
    panel("left")?.classList.contains("open") === true ||
    panel("right")?.classList.contains("open") === true;
  main.classList.toggle("drawer-open", anyOpen);
}

export function closeDrawers(): void {
  for (const side of ["left", "right"] as Side[]) {
    panel(side)?.classList.remove("open");
    setToggleState(side, false);
  }
  syncScrim();
}

/**
 * 드로어 열기/닫기. 좁은 화면에서는 한 번에 하나만 열어 캔버스를 최대한 남긴다.
 * 데스크톱(3열)에서는 두 패널이 늘 보이므로 아무 것도 하지 않는다.
 */
export function toggleDrawer(side: Side, force?: boolean): void {
  if (!isDrawerMode()) return;
  const p = panel(side);
  if (!p) return;
  const open = force ?? !p.classList.contains("open");
  if (open) {
    // 반대쪽은 닫는다 — 좁은 화면에서 양쪽이 동시에 캔버스를 덮지 않도록
    const other: Side = side === "left" ? "right" : "left";
    panel(other)?.classList.remove("open");
    setToggleState(other, false);
  }
  p.classList.toggle("open", open);
  setToggleState(side, open);
  syncScrim();
}

/**
 * 우측 패널에 새 내용(건물 선택·분석 결과)이 들어왔음을 알린다.
 * 드로어 모드에서 패널이 닫혀 있으면 툴바 "결과" 버튼에 앰버 강조를 붙여
 * 자동으로 캔버스를 가리지 않으면서도 갱신 사실을 알린다.
 */
export function notifyRightPanel(): void {
  if (!isDrawerMode()) return;
  const p = panel("right");
  if (p?.classList.contains("open")) return;
  el(TOGGLE_ID.right)?.classList.add("attention");
}

// ---------- 툴바 "파일" 드롭다운 ----------

function closeFileMenu(): void {
  const menu = el("tb-file-menu");
  const btn = el("tb-file-btn");
  if (menu) menu.hidden = true;
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("active");
  }
}

function initFileMenu(): void {
  const btn = el("tb-file-btn");
  const menu = el("tb-file-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("active", open);
  });

  // 메뉴 항목(파일 열기 label 포함)을 고르면 바로 닫는다
  menu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".menu-item")) closeFileMenu();
  });

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (!menu.contains(e.target as Node) && e.target !== btn) closeFileMenu();
  });
}

// ---------- 상태바 상세(경고) 모달 ----------

function initNoticeModal(): void {
  const modal = el("notice-modal");
  const body = el("notice-body");
  const openBtn = el<HTMLButtonElement>("status-detail");
  const closeBtn = el("close-notice");
  if (!modal || !body || !openBtn) return;

  openBtn.addEventListener("click", () => {
    body.textContent = openBtn.dataset.detail ?? "";
    modal.hidden = false;
  });
  closeBtn?.addEventListener("click", () => {
    modal.hidden = true;
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

// ---------- 조작 안내 (마우스 ↔ 터치) ----------

/** 터치 기기에서는 "휠 줌 · 우드래그 팬" 안내가 무의미하므로 제스처 안내로 교체한다 */
function initHelpHint(): void {
  const hint = el("gesture-hint");
  if (!hint) return;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  hint.innerHTML = coarse
    ? "한 손가락: 회전 · 두 손가락: 확대/이동<br />" +
      "인접건물 벽을 탭하면 그 지점 일조시간 표시"
    : "좌드래그 회전 · 휠 줌 · 우드래그 이동<br />" +
      "인접건물 벽을 클릭하면 그 지점 일조시간 표시";
}

// ---------- 초기화 ----------

/** 좌측 패널 큰 섹션은 한 번에 하나만 펼친다 — 여러 개가 열려 길게 늘어지는 것을 막는다 */
function initAccordion(): void {
  const items = document.querySelectorAll<HTMLDetailsElement>("#left-panel details.lp-acc");
  for (const d of items) {
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      for (const o of items) if (o !== d && o.open) o.open = false;
    });
  }
}

export function initShell(): void {
  initAccordion();
  drawerMedia = window.matchMedia(DRAWER_QUERY);

  for (const side of ["left", "right"] as Side[]) {
    el(TOGGLE_ID[side])?.addEventListener("click", () => toggleDrawer(side));
  }

  el("drawer-scrim")?.addEventListener("click", () => closeDrawers());

  // 좌측 드로어의 실행 버튼(primary)을 누르면 결과를 봐야 하므로 드로어를 접는다.
  // 토글·체크박스류(mini·checkbox)는 연속 조작이 많아 대상에서 제외.
  panel("left")?.addEventListener("click", (e) => {
    if (!isDrawerMode()) return;
    const target = e.target as HTMLElement;
    if (target.closest("button.primary, .btn.primary")) toggleDrawer("left", false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeFileMenu();
    const notice = el("notice-modal");
    if (notice && !notice.hidden) {
      notice.hidden = true;
      return;
    }
    closeDrawers();
  });

  // 데스크톱 폭으로 돌아오면 드로어 상태를 초기화 (3열 레이아웃에서 잔여 클래스 방지)
  drawerMedia.addEventListener("change", (ev) => {
    if (!ev.matches) closeDrawers();
  });

  initFileMenu();
  initNoticeModal();
  initHelpHint();
}
