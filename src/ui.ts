import type { DaylightResult } from "./daylight";
import {
  coverageStats,
  MASS_TYPE_LABEL,
  residentialFloors,
  siteUnitTotals,
  totalUnits,
  unitBreakdown,
  unitSummaryText,
  type SiteUnitTotals,
} from "./massing";
import type { NorthSetbackResult } from "./northsetback";
import { PV_TOP_THRESHOLD, type PvBuildingSummary } from "./pv";
import type { PvEnergyBuildingSummary } from "./pvenergy";
import type { SpacingResult } from "./spacing";
import type { SunHoursBuildingSummary } from "./sunhours";
import type { SunHoursMapResult } from "./sunhoursmap";
import { windDirLabel, type WindResult } from "./wind";
import { buildingHeight, mirrorLabel, type Building } from "./types";

export interface UiCallbacks {
  onParamsChange(b: Building): void;
  onSelect(id: string | null): void;
  onResetOffset(b: Building): void;
  /** 회전 등 offset만 바뀌었을 때 (지오메트리 재생성 불필요) */
  onOffsetChange(b: Building): void;
  /** M6: 템플릿 매스 파라미터(층당 세대·분절 수) 변경 — footprint 재생성 필요 */
  onMassParamsChange(b: Building): void;
  /** M6: 평형 이름·세대수 편집 — 지오메트리 불변, 세대수 합계만 갱신 */
  onUnitMixChange(b: Building): void;
  /** 평형 추가 — 행 개수가 바뀌므로 목록 재렌더링 필요 */
  onUnitMixAdd(b: Building): void;
  /** 평형 삭제 — 행 개수가 바뀌므로 목록 재렌더링 필요 */
  onUnitMixRemove(b: Building, index: number): void;
  /** footprint 좌우/상하반전 — footprint 자체가 바뀌므로 재생성 필요 */
  onMirror(b: Building, axis: "h" | "v"): void;
  /** 장면에서 이 건물 인스턴스를 삭제 (라이브러리에는 영향 없음) */
  onDelete(b: Building): void;
  /** 같은 footprint의 새 인스턴스를 장면에 복제 */
  onDuplicate(b: Building): void;
}

/** 건물별 법적 검토 상태 도트 4종 — 접힌 아코디언 행에서도 한눈에 보이도록 */
export type DotStatus = "pass" | "fail" | "na";

export interface BuildingStatus {
  /** 정북사선(건축법 시행령 제86조 제1항) — 계획주동만 해당 */
  m2: DotStatus;
  /** 채광사선 — 계획주동 창면만 해당 */
  m3d: DotStatus;
  /** 인동거리 — 계획주동 쌍만 해당 */
  m3s: DotStatus;
  /** 일조권(수인한도, 연속2h/총4h) — 인접건물만 해당 */
  sh: DotStatus;
}

export function emptyBuildingStatus(): BuildingStatus {
  return { m2: "na", m3d: "na", m3s: "na", sh: "na" };
}

/**
 * 상태바 메시지 갱신.
 * @param detail 있으면 툴팁(title)으로 붙는다 — DXF 경고처럼 한 줄에 다 못 넣는 상세 내용용.
 *   (console.warn만으로는 DevTools를 열지 않는 사용자에게 전달되지 않는다)
 */
export function setStatus(msg: string, detail?: string): void {
  const el = document.getElementById("statusbar");
  if (el) {
    el.textContent = msg;
    if (detail) el.setAttribute("title", detail);
    else el.removeAttribute("title");
  }
  // "… 42%" 형태의 진행 메시지면 캔버스 상단 앰버 진행바를 함께 갱신
  const bar = document.getElementById("progress-bar");
  if (bar) {
    const m = /(\d+)%/.exec(msg);
    if (m) {
      bar.classList.add("active");
      bar.style.width = `${Math.min(100, parseInt(m[1], 10))}%`;
    } else {
      bar.classList.remove("active");
      bar.style.width = "0";
    }
  }
}

/** 사이드 패널의 건물 목록을 다시 그린다 — 계획주동/인접건물 섹션으로 나눈 아코디언 */
export function renderBuildingList(
  buildings: Building[],
  selectedId: string | null,
  statusMap: Map<string, BuildingStatus>,
  cb: UiCallbacks,
): void {
  const root = document.getElementById("building-list")!;
  root.innerHTML = "";
  // 우측 패널 — 선택된 건물의 상세 편집 화면 (미선택 시 빈 상태)
  const selected = buildings.find((b) => b.id === selectedId) ?? null;
  renderBuildingDetail(
    selected,
    selected ? statusMap.get(selected.id) ?? emptyBuildingStatus() : null,
    cb,
  );
  if (buildings.length === 0) {
    root.innerHTML = `<p class="hint">DXF를 불러오거나 라이브러리에서 건물을 추가하세요.</p>`;
    return;
  }

  const plans = buildings.filter((b) => b.type === "계획주동");
  const adjs = buildings.filter((b) => b.type === "인접건물");

  if (plans.length > 0) {
    root.appendChild(sectionHeading(`계획주동 (${plans.length})`));
    for (const b of plans) {
      root.appendChild(
        renderAccordionItem(b, b.id === selectedId, statusMap.get(b.id) ?? emptyBuildingStatus(), cb),
      );
    }
  }
  // 인접건물은 수십 동이 될 수 있어 목록을 채우지 않는다 — 3D 화면에서 클릭해
  // 선택한 건물의 카드만 여기 표시된다.
  if (adjs.length > 0) {
    root.appendChild(sectionHeading(`인접건물 (${adjs.length})`));
    const selectedAdj = adjs.find((b) => b.id === selectedId);
    if (selectedAdj) {
      root.appendChild(
        renderAccordionItem(
          selectedAdj,
          true,
          statusMap.get(selectedAdj.id) ?? emptyBuildingStatus(),
          cb,
        ),
      );
    } else {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "3D 화면에서 인접건물을 클릭하면 상세 정보가 여기 표시됩니다.";
      root.appendChild(hint);
    }
  }
}

function sectionHeading(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "list-section-heading";
  h.textContent = text;
  return h;
}

function dotSpan(kind: "m2" | "m3d" | "m3s" | "sh", status: DotStatus, title: string): HTMLSpanElement {
  const dot = document.createElement("span");
  dot.className = `status-dot dot-${kind} ${status}`;
  dot.title = title;
  return dot;
}

/** 아코디언 항목 1개 — 접힌 헤더(이름·층수·상태도트·삭제) + 펼침 본문(기존 상세 입력) */
function renderAccordionItem(
  b: Building,
  expanded: boolean,
  status: BuildingStatus,
  cb: UiCallbacks,
): HTMLElement {
  const isPlan = b.type === "계획주동";
  const card = document.createElement("div");
  card.className =
    "building-card accordion-item" + (expanded ? " selected expanded" : "");
  card.dataset.id = b.id;

  // ---------- 접힌 헤더 ----------
  const header = document.createElement("div");
  header.className = "accordion-header";

  const arrow = document.createElement("span");
  arrow.className = "accordion-arrow";
  arrow.textContent = expanded ? "▼" : "▶";
  header.appendChild(arrow);

  const nameEl = document.createElement("span");
  nameEl.className = "bname";
  nameEl.textContent = b.name;
  header.appendChild(nameEl);

  const floorBadge = document.createElement("span");
  floorBadge.className = "floor-badge";
  floorBadge.textContent = `${b.floors}F`;
  header.appendChild(floorBadge);

  const dots = document.createElement("span");
  dots.className = "status-dots";
  dots.append(
    dotSpan("m2", status.m2, "정북사선"),
    dotSpan("m3d", status.m3d, "채광사선"),
    dotSpan("m3s", status.m3s, "인동거리"),
    dotSpan("sh", status.sh, "일조권(수인한도)"),
  );
  header.appendChild(dots);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "🗑";
  deleteBtn.title = "장면에서 삭제";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onDelete(b);
  });
  header.appendChild(deleteBtn);

  header.addEventListener("click", () => cb.onSelect(expanded ? null : b.id));
  card.appendChild(header);

  // ---------- 펼침 본문 (간략) — 상세 편집은 우측 패널(renderBuildingDetail) ----------
  const body = document.createElement("div");
  body.className = "accordion-body";
  body.hidden = !expanded;
  if (expanded) {
    const typeLabel =
      isPlan && b.massType !== "custom" ? MASS_TYPE_LABEL[b.massType] : b.type;
    const brief = document.createElement("div");
    brief.className = "brief-line";
    const badge = document.createElement("span");
    badge.className = `badge ${isPlan ? "plan" : "adj"}`;
    badge.textContent = typeLabel;
    const heightEl = document.createElement("span");
    heightEl.className = "brief-height";
    heightEl.textContent = `높이 ${buildingHeight(b).toFixed(1)}m`;
    brief.append(badge, heightEl);
    body.appendChild(brief);

    const actions = document.createElement("div");
    actions.className = "num-row accordion-actions";
    const dup = document.createElement("button");
    dup.className = "duplicate-btn";
    dup.textContent = "복제";
    dup.title = "같은 형태의 새 인스턴스를 장면에 추가";
    dup.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onDuplicate(b);
    });
    const del = document.createElement("button");
    del.className = "duplicate-btn";
    del.textContent = "삭제";
    del.title = "장면에서 삭제";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onDelete(b);
    });
    actions.append(dup, del);
    body.appendChild(actions);
  }
  card.appendChild(body);

  return card;
}

function statusText(s: DotStatus): string {
  return s === "pass" ? "적합" : s === "fail" ? "위반" : "미검토";
}

/**
 * 우측 패널 — 선택된 건물의 상세 편집 화면.
 * 본문은 기존 fillAccordionBody를 그대로 재사용하므로 콜백·targeted refresh
 * (.building-card[data-id] 셀렉터 기반)가 모두 동일하게 동작한다.
 */
function renderBuildingDetail(
  b: Building | null,
  status: BuildingStatus | null,
  cb: UiCallbacks,
): void {
  const host = document.getElementById("building-detail");
  if (!host) return;
  host.innerHTML = "";
  if (!b || !status) {
    host.innerHTML =
      `<div class="detail-empty">건물을 선택하세요` +
      `<span>장면 목록 또는 3D 화면에서 건물을 클릭하면<br />상세 정보가 여기 표시됩니다</span></div>`;
    return;
  }
  const isPlan = b.type === "계획주동";

  const head = document.createElement("div");
  head.className = "detail-head";
  const nm = document.createElement("div");
  nm.className = "detail-name";
  nm.textContent = b.name;
  const tp = document.createElement("div");
  tp.className = "detail-type";
  tp.textContent = `${b.type} · ${b.floors}F`;
  head.append(nm, tp);
  host.appendChild(head);

  const card = document.createElement("div");
  card.className = "building-card detail-card";
  card.dataset.id = b.id;
  fillAccordionBody(card, b, isPlan, cb);

  // 검토 결과 — statusMap 기반 도트+판정 (refreshStatusDots가 실시간 갱신)
  const rows: [string, string, DotStatus][] = isPlan
    ? [
        ["m2", "정북사선", status.m2],
        ["m3d", "채광사선", status.m3d],
        ["m3s", "인동거리", status.m3s],
      ]
    : [["sh", "일조권(수인한도)", status.sh]];
  const checks = document.createElement("div");
  checks.className = "detail-checks";
  let html = `<div class="detail-sec-title">검토 결과</div>`;
  for (const [kind, label, st] of rows) {
    html +=
      `<div class="chk-row"><span class="status-dot dot-${kind} ${st}"></span>` +
      `<span class="chk-label">${label}</span>` +
      `<span class="chk-text chk-${kind} ${st}">${statusText(st)}</span></div>`;
  }
  checks.innerHTML = html;
  card.appendChild(checks);
  host.appendChild(card);
}

function fillAccordionBody(
  card: HTMLElement,
  b: Building,
  isPlan: boolean,
  cb: UiCallbacks,
): void {
  {
    const typeLabel =
      isPlan && b.massType !== "custom" ? MASS_TYPE_LABEL[b.massType] : b.type;
    const nameRow = document.createElement("div");
    nameRow.className = "name-row";
    nameRow.innerHTML = `<span class="badge ${isPlan ? "plan" : "adj"}">${typeLabel}</span>`;
    card.appendChild(nameRow);
  }

  const numRow = document.createElement("div");
    numRow.className = "num-row";

    const floorsInput = numberInput(b.floors, 1, 100, 1);
    floorsInput.addEventListener("change", () => {
      b.floors = clampNum(floorsInput, 1, 100);
      heightInfo.textContent = heightText(b);
      refreshUnitInfo(b);
      cb.onParamsChange(b);
    });
    numRow.appendChild(labelWrap("층수", floorsInput));

    const fhInput = numberInput(b.floorHeight, 2, 10, 0.1);
    fhInput.addEventListener("change", () => {
      b.floorHeight = clampNum(fhInput, 2, 10);
      heightInfo.textContent = heightText(b);
      cb.onParamsChange(b);
    });
    numRow.appendChild(labelWrap("층고(m)", fhInput));
    card.appendChild(numRow);

    if (isPlan) {
      const numRow2 = document.createElement("div");
      numRow2.className = "num-row";

      const rotInput = numberInput(b.offset.rotation, -360, 360, 1);
      rotInput.classList.add("rot-input");
      rotInput.addEventListener("change", () => {
        b.offset.rotation = clampNum(rotInput, -360, 360);
        heightInfo.textContent = heightText(b);
        cb.onOffsetChange(b);
      });
      numRow2.appendChild(labelWrap("회전(°)", rotInput));

      const pilotiInput = numberInput(b.pilotiFloors, 0, 10, 1);
      pilotiInput.addEventListener("change", () => {
        b.pilotiFloors = clampNum(pilotiInput, 0, Math.max(0, b.floors - 1));
        pilotiInput.value = String(b.pilotiFloors);
        refreshUnitInfo(b);
        cb.onParamsChange(b);
      });
      numRow2.appendChild(labelWrap("필로티", pilotiInput));
      card.appendChild(numRow2);

      const mirrorRow = document.createElement("div");
      mirrorRow.className = "num-row mirror-row";
      const mirrorHBtn = document.createElement("button");
      mirrorHBtn.textContent = "좌우반전";
      mirrorHBtn.title = "Mirror H — 중심 수직축 기준 좌우반전";
      mirrorHBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onMirror(b, "h");
      });
      const mirrorVBtn = document.createElement("button");
      mirrorVBtn.textContent = "상하반전";
      mirrorVBtn.title = "Mirror V — 중심 수평축 기준 상하반전";
      mirrorVBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onMirror(b, "v");
      });
      const mirrorState = document.createElement("span");
      mirrorState.className = "mirror-state";
      mirrorState.textContent = `미러: ${mirrorLabel(b)}`;
      mirrorRow.append(mirrorHBtn, mirrorVBtn, mirrorState);
      card.appendChild(mirrorRow);
    }

    const heightInfo = document.createElement("div");
    heightInfo.className = "height-info";
    heightInfo.textContent = heightText(b);
    card.appendChild(heightInfo);

    // M6/M6.8: 세대수 자동산출 — 평형별 "층당 세대수" 입력 → 총 세대수 = 층당 × 주거층수(×분절)
    if (isPlan && b.unitsPerFloor > 0) {
      const unitInfo = document.createElement("div");
      unitInfo.className = "unit-info";
      const calcSpans: HTMLElement[] = [];
      const refreshUnits = () => {
        unitInfo.textContent = unitSummaryText(totalUnits(b), unitBreakdown(b));
        const floors = residentialFloors(b) * Math.max(1, b.segments);
        calcSpans.forEach((span, i) => {
          const entry = b.unitMix[i];
          if (!entry) return;
          const per = Math.max(0, Math.round(entry.countPerFloor));
          span.textContent = `× ${floors}층 = ${per * floors}세대`;
        });
      };

      const numRow3 = document.createElement("div");
      numRow3.className = "num-row";

      const upfInput = numberInput(b.unitsPerFloor, 1, 20, 1);
      upfInput.classList.add("upf-input");
      upfInput.addEventListener("change", () => {
        b.unitsPerFloor = clampNum(upfInput, 1, 20);
        // 템플릿 매스는 층당 세대 수가 footprint 폭을 결정 — 재생성
        cb.onMassParamsChange(b);
      });
      numRow3.appendChild(labelWrap("층당세대", upfInput));

      if (b.massType === "segment") {
        const segInput = numberInput(b.segments, 2, 6, 1);
        segInput.addEventListener("change", () => {
          b.segments = clampNum(segInput, 2, 6);
          refreshUnits();
          cb.onMassParamsChange(b);
        });
        numRow3.appendChild(labelWrap("분절", segInput));
      }
      card.appendChild(numRow3);

      // M6.8: 평형별 "층당 세대수" 직접 입력 — 총 세대수는 층당 × 주거층수로 자동 계산되어
      // 층수·필로티·분절이 바뀌면 즉시 갱신된다. 추가/삭제 가능.
      const mixList = document.createElement("div");
      mixList.className = "unit-mix-list";
      for (let i = 0; i < b.unitMix.length; i++) {
        const entry = b.unitMix[i];
        const mixRow = document.createElement("div");
        mixRow.className = "num-row mix-row";

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "unit-type-name";
        nameInput.value = entry.unitType;
        nameInput.addEventListener("change", () => {
          entry.unitType = nameInput.value.trim() || entry.unitType;
          nameInput.value = entry.unitType;
          refreshUnits();
          cb.onUnitMixChange(b);
        });

        const countInput = numberInput(entry.countPerFloor, 0, 50, 1);
        countInput.addEventListener("change", () => {
          entry.countPerFloor = clampNum(countInput, 0, 50);
          refreshUnits();
          cb.onUnitMixChange(b);
        });

        const unitLabel = document.createElement("span");
        unitLabel.className = "mix-unit-suffix";
        unitLabel.textContent = "세대/층";

        const calcSpan = document.createElement("span");
        calcSpan.className = "mix-calc";
        calcSpans.push(calcSpan);

        const removeBtn = document.createElement("button");
        removeBtn.className = "mix-remove";
        removeBtn.textContent = "×";
        removeBtn.title = "이 평형 삭제";
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          cb.onUnitMixRemove(b, i);
        });

        mixRow.append(nameInput, countInput, unitLabel, calcSpan, removeBtn);
        mixList.appendChild(mixRow);
      }
      card.appendChild(mixList);

      const addTypeBtn = document.createElement("button");
      addTypeBtn.className = "mix-add";
      addTypeBtn.textContent = "+ 평형 추가";
      addTypeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onUnitMixAdd(b);
      });
      card.appendChild(addTypeBtn);

      refreshUnits();
      card.appendChild(unitInfo);

      const mixHint = document.createElement("div");
      mixHint.className = "mix-hint";
      mixHint.textContent =
        "평형별 층당세대수를 수정하면 그 합이 위 '층당세대'(매스 폭)에 자동 반영됩니다. 총 세대수는 층수·필로티·분절 변경 시 자동 재계산됩니다.";
      card.appendChild(mixHint);
    }

  const actionRow = document.createElement("div");
  actionRow.className = "num-row accordion-actions";
  if (isPlan) {
    const reset = document.createElement("button");
    reset.className = "reset-offset";
    reset.textContent = "위치 초기화";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onResetOffset(b);
    });
    actionRow.appendChild(reset);
  }
  const dup = document.createElement("button");
  dup.className = "duplicate-btn";
  dup.textContent = "복제";
  dup.title = "같은 형태의 새 인스턴스를 장면에 추가";
  dup.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onDuplicate(b);
  });
  actionRow.appendChild(dup);
  card.appendChild(actionRow);
}

/**
 * M2/M3 결과가 갱신될 때마다 호출 — 아코디언을 통째로 다시 그리지 않고
 * 각 카드의 상태 도트만 targeted patch. 드래그·회전 중 매 프레임 호출돼도 저렴하다.
 */
export function refreshStatusDots(statusMap: Map<string, BuildingStatus>): void {
  for (const [id, status] of statusMap) {
    const kinds = [
      ["m2", status.m2],
      ["m3d", status.m3d],
      ["m3s", status.m3s],
      ["sh", status.sh],
    ] as const;
    for (const [kind, st] of kinds) {
      // 좌측 아코디언 헤더 도트 + 우측 패널 검토결과 도트를 모두 갱신
      document
        .querySelectorAll(`.building-card[data-id="${id}"] .dot-${kind}`)
        .forEach((el) => setDotStatus(el, st));
      document
        .querySelectorAll(`.building-card[data-id="${id}"] .chk-${kind}`)
        .forEach((el) => {
          setDotStatus(el, st);
          el.textContent = statusText(st);
        });
    }
  }
}

function setDotStatus(el: Element | null, status: DotStatus): void {
  if (!el) return;
  el.classList.remove("pass", "fail", "na");
  el.classList.add(status);
}

/**
 * 건물 라이브러리(DXF에서 불러온 PLAN_BLDG 템플릿) 체크박스 목록.
 * 체크는 "장면에 추가" 대상 선택일 뿐 장면 포함 여부와는 별개다.
 */
export function renderLibraryList(
  library: Building[],
  checkedIds: Set<string>,
  onToggle: (id: string, checked: boolean) => void,
): void {
  const root = document.getElementById("library-list");
  if (!root) return;
  root.innerHTML = "";
  if (library.length === 0) {
    root.innerHTML = `<p class="hint">DXF를 불러오면 계획주동(PLAN_BLDG) 템플릿이 여기 쌓입니다.</p>`;
    return;
  }
  for (const b of library) {
    const row = document.createElement("label");
    row.className = "library-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checkedIds.has(b.id);
    checkbox.addEventListener("change", () => onToggle(b.id, checkbox.checked));
    const label = document.createElement("span");
    label.className = "lib-name";
    label.textContent = `${b.name} · ${b.floors}F`;
    // 출처 배지 — 기본 샘플 템플릿 vs DXF에서 불러온 템플릿
    const isSample = b.id.startsWith("sample-");
    const badge = document.createElement("span");
    badge.className = `badge ${isSample ? "lib-sample" : "lib-dxf"}`;
    badge.textContent = isSample ? "기본" : "DXF";
    row.append(checkbox, label, badge);
    root.appendChild(row);
  }
}

function heightText(b: Building): string {
  const off = b.offset;
  const moved =
    Math.abs(off.dx) > 0.01 || Math.abs(off.dy) > 0.01
      ? ` · 이동 (${off.dx.toFixed(1)}, ${off.dy.toFixed(1)})m`
      : "";
  const rotated =
    Math.abs(off.rotation) > 0.01 ? ` · 회전 ${off.rotation.toFixed(0)}°` : "";
  return `높이 ${buildingHeight(b).toFixed(1)}m${moved}${rotated}`;
}

/** 미러 버튼 클릭 후 카드의 미러 상태 표시만 갱신 */
export function refreshMirrorInfo(b: Building): void {
  const el = document.querySelector(
    `.building-card[data-id="${b.id}"] .mirror-state`,
  );
  if (el) el.textContent = `미러: ${mirrorLabel(b)}`;
}

/**
 * 층수·필로티·분절 변경 시 카드의 세대수 표시를 갱신 (M6/M6.8).
 * 평형별 "층당세대수 × 층수 = 세대수" 계산 문구도 함께 갱신한다 — 총 세대수가
 * countPerFloor × 주거층수로 파생되므로 층수 변경이 즉시 반영돼야 한다.
 */
export function refreshUnitInfo(b: Building): void {
  // 상세 본문은 우측 패널의 detail-card에 있으므로 전체 셀렉터로 찾는다
  // (좌측 목록 카드에는 unit-info/mix-row가 없다)
  const infoEl = document.querySelector(
    `.building-card[data-id="${b.id}"] .unit-info`,
  );
  if (infoEl) infoEl.textContent = unitSummaryText(totalUnits(b), unitBreakdown(b));
  const floors = residentialFloors(b) * Math.max(1, b.segments);
  const rows = document.querySelectorAll<HTMLElement>(
    `.building-card[data-id="${b.id}"] .mix-row`,
  );
  rows.forEach((row, i) => {
    const entry = b.unitMix[i];
    const calc = row.querySelector(".mix-calc");
    if (calc && entry) {
      const per = Math.max(0, Math.round(entry.countPerFloor));
      calc.textContent = `× ${floors}층 = ${per * floors}세대`;
    }
  });
}

/**
 * M6: 사이드 패널 하단 — 전체 사이트 세대수 합계 + 건폐율·용적률.
 * 우측 패널 상단 "세대수 요약"(전체 합계 + 타입별 표)도 여기서 함께 갱신 —
 * 배치·설정이 바뀔 때마다 호출 (결정적 계산이라 비용 무시 가능).
 */
export function renderSiteTotals(
  buildings: Building[],
  siteAreaM2: number,
): void {
  const t = siteUnitTotals(buildings);
  const totalsEl = document.getElementById("site-totals");
  if (totalsEl) {
    if (t.buildingCount === 0) {
      totalsEl.textContent = "계획주동이 없습니다.";
    } else {
      const mix = t.byType.map((u) => `${u.unitType} ${u.count}`).join(" / ");
      totalsEl.textContent =
        `계획주동 ${t.buildingCount}동 · 총 ${t.total}세대` +
        (mix ? ` (${mix})` : "");
    }
  }
  renderUnitSummary(t);
  const bcrEl = document.getElementById("bcr-far");
  if (bcrEl) {
    const s = coverageStats(buildings, siteAreaM2);
    bcrEl.textContent =
      s.bcrPct === null
        ? `건축면적 ${s.coverageM2.toFixed(0)}㎡ · 연면적 ${s.grossM2.toFixed(0)}㎡ — 대지면적을 입력하면 건폐율·용적률 표시`
        : `건폐율 ${s.bcrPct.toFixed(1)}% · 용적률 ${s.farPct!.toFixed(1)}%` +
          ` (건축면적 ${s.coverageM2.toFixed(0)}㎡ · 연면적 ${s.grossM2.toFixed(0)}㎡)`;
  }
}

/**
 * 우측 패널 "세대수 요약" — 전체 세대수 합계 + 타입별 세대수 표.
 * unitType은 사용자 입력 문자열이라 innerHTML 대신 DOM 생성으로 넣는다.
 */
function renderUnitSummary(t: SiteUnitTotals): void {
  const host = document.getElementById("unit-summary-body");
  if (!host) return;
  host.innerHTML = "";
  if (t.buildingCount === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "계획주동을 배치하면 전체·타입별 세대수가 표시됩니다.";
    host.appendChild(p);
    return;
  }
  const totalLine = document.createElement("div");
  totalLine.className = "unit-total";
  const b = document.createElement("b");
  b.textContent = String(t.total);
  totalLine.append(`계획주동 ${t.buildingCount}동 · 총 `, b, "세대");
  host.appendChild(totalLine);

  if (t.byType.length === 0) return;
  const table = document.createElement("table");
  table.className = "unit-table";
  const thead = table.createTHead().insertRow();
  for (const [text, cls] of [
    ["타입", ""],
    ["세대수", "num"],
    ["비율", "num"],
  ] as const) {
    const th = document.createElement("th");
    th.textContent = text;
    if (cls) th.className = cls;
    thead.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const u of t.byType) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = u.unitType;
    const cnt = tr.insertCell();
    cnt.className = "num";
    cnt.textContent = String(u.count);
    const pct = tr.insertCell();
    pct.className = "num";
    pct.textContent = t.total > 0 ? `${((u.count / t.total) * 100).toFixed(1)}%` : "-";
  }
  const totalRow = tbody.insertRow();
  totalRow.className = "total-row";
  totalRow.insertCell().textContent = "합계";
  const totalCell = totalRow.insertCell();
  totalCell.className = "num";
  totalCell.textContent = String(t.total);
  const pctCell = totalRow.insertCell();
  pctCell.className = "num";
  pctCell.textContent = "100%";
  host.appendChild(table);
}

/** 평형별 층당세대수 합이 바뀌어 unitsPerFloor가 파생 갱신됐을 때 카드의 '층당세대' 입력값만 갱신 */
export function refreshUpfInput(b: Building): void {
  const input = document.querySelector<HTMLInputElement>(
    `.building-card[data-id="${b.id}"] .upf-input`,
  );
  if (input) input.value = String(b.unitsPerFloor);
}

/** 드래그·회전으로 offset이 바뀌었을 때 카드 텍스트만 갱신 */
export function refreshOffsetInfo(b: Building): void {
  const card = document.querySelector(
    `.building-card[data-id="${b.id}"] .height-info`,
  );
  if (card) card.textContent = heightText(b);
  const rotInput = document.querySelector<HTMLInputElement>(
    `.building-card[data-id="${b.id}"] .rot-input`,
  );
  if (rotInput) rotInput.value = b.offset.rotation.toFixed(0);
}

/**
 * 법적 사선·이격 검토 요약 표시 — 정북사선·채광사선·인동거리 3종을 한 패널에 모은다.
 * 셋 다 순수 기하 계산(태양 위치·raycasting 불필요)이라 드래그·회전 중 실시간 갱신 가능.
 * 꺼져 있는(미실행) 검토는 null로 전달.
 */
/** 하단 상태바 — 정북/채광/인동 적합 집계 (도트 + N/N) */
function updateStatusChecks(
  northSetback: NorthSetbackResult | null,
  daylight: DaylightResult | null,
  spacing: SpacingResult | null,
): void {
  const el = document.getElementById("status-checks");
  if (!el) return;
  const seg = (label: string, pass: number | null, total: number | null): string => {
    if (pass === null || total === null) {
      return `<span class="sb-item na"><i class="sb-dot"></i>${label} 미검토</span>`;
    }
    if (total === 0) {
      return `<span class="sb-item na"><i class="sb-dot"></i>${label} —</span>`;
    }
    const ok = pass === total;
    return (
      `<span class="sb-item ${ok ? "ok" : "bad"}"><i class="sb-dot"></i>` +
      `${label} ${pass}/${total} ${ok ? "적합" : "위반"}</span>`
    );
  };
  el.innerHTML =
    seg(
      "정북",
      northSetback ? northSetback.checks.filter((c) => c.pass).length : null,
      northSetback ? northSetback.checks.length : null,
    ) +
    seg(
      "채광",
      daylight ? daylight.checks.filter((c) => c.pass).length : null,
      daylight ? daylight.checks.length : null,
    ) +
    seg(
      "인동",
      spacing ? spacing.checks.filter((c) => c.pass).length : null,
      spacing ? spacing.checks.length : null,
    );
}

export function renderSetbackSummary(
  northSetback: NorthSetbackResult | null,
  daylight: DaylightResult | null,
  spacing: SpacingResult | null,
): void {
  updateStatusChecks(northSetback, daylight, spacing);
  const root = document.getElementById("setback-summary")!;
  root.innerHTML = "";
  if (!northSetback && !daylight && !spacing) return;

  if (northSetback) {
    const div = document.createElement("div");
    div.className = "summary-card";
    let html =
      `<div class="bname">정북사선 (${northSetback.lowHeightM}m 이하 ${northSetback.lowM}m` +
      ` · 초과 높이×${northSetback.ratio} 이격 — 제86조 제1항)</div>`;
    if (northSetback.checks.length === 0) {
      html += `<div class="surf-line">계획주동이 없습니다.</div>`;
    } else {
      for (const c of northSetback.checks) {
        const cls = c.pass ? "ok" : "bad";
        const detail =
          c.distance !== null && c.allowedHeight !== null
            ? `D=${c.distance.toFixed(1)}m → 허용 ${c.allowedHeight.toFixed(1)}m`
            : "기준선 미검출(제한 없음)";
        html +=
          `<div class="surf-line">${c.buildingName}: ` +
          `<b class="${cls}">${c.pass ? "적합" : "위반"}</b> · ` +
          `실제 ${c.actualHeight.toFixed(1)}m / ${detail}</div>`;
      }
    }
    div.innerHTML = html;
    root.appendChild(div);
  }

  if (daylight) {
    const div = document.createElement("div");
    div.className = "summary-card";
    let html = `<div class="bname">채광사선 (대지경계 H/D≤${daylight.boundaryRatio} · 도로/공원 H/D≤${daylight.roadParkRatio})</div>`;
    if (daylight.checks.length === 0) {
      html += `<div class="surf-line">창면(PLAN_WIN)이 있는 계획주동이 없습니다.</div>`;
    } else {
      // 주동별 위반/전체 창 개수 + 최악 H/D
      const byBldg = new Map<
        string,
        { name: string; total: number; fail: number; worst: number }
      >();
      for (const c of daylight.checks) {
        let s = byBldg.get(c.buildingId);
        if (!s) {
          s = { name: c.buildingName, total: 0, fail: 0, worst: 0 };
          byBldg.set(c.buildingId, s);
        }
        s.total++;
        if (!c.pass) s.fail++;
        if (c.ratio !== null) s.worst = Math.max(s.worst, c.ratio);
      }
      for (const s of byBldg.values()) {
        const cls = s.fail === 0 ? "ok" : "bad";
        const worst = s.worst > 0 ? ` · 최대 H/D ${s.worst.toFixed(2)}` : "";
        html += `<div class="surf-line">${s.name}: <b class="${cls}">${
          s.fail === 0 ? "적합" : `위반 ${s.fail}`
        }</b> / 창 ${s.total}${worst}</div>`;
      }
    }
    if (daylight.skippedBuildings.length > 0) {
      html += `<div class="surf-line">PLAN_WIN 없어 제외: ${daylight.skippedBuildings.join(", ")}</div>`;
    }
    div.innerHTML = html;
    root.appendChild(div);
  }

  if (spacing) {
    const div = document.createElement("div");
    div.className = "summary-card";
    let html =
      `<div class="bname">인동거리 (채광×${spacing.ratioWindow} · ` +
      `창없음 ${spacing.noWindowM}m · 측벽 ${spacing.sideM}m)</div>`;
    if (spacing.checks.length === 0) {
      html += `<div class="surf-line">마주보는 계획주동 쌍이 없습니다 (2동 이상 + 벽면 직각방향으로 마주봐야 검토).</div>`;
    } else {
      for (const c of spacing.checks) {
        const cls = c.pass ? "ok" : "bad";
        html +=
          `<div class="surf-line">${c.aName} ↔ ${c.bName} (${c.rule}·겹침 ${c.overlapLen.toFixed(0)}m): ` +
          `<b class="${cls}">${c.distance.toFixed(1)}m</b>` +
          ` / 기준 ${c.required.toFixed(1)}m ${c.pass ? "적합" : "위반"}</div>`;
      }
    }
    div.innerHTML = html;
    root.appendChild(div);
  }
}

/** 일조권 상세 팝업 DOM — 최초 호출 시 1회 생성해 body에 붙인다 (style.css .modal-overlay 재사용) */
function ensureSunHoursModal(): { overlay: HTMLElement; body: HTMLElement } {
  let overlay = document.getElementById("sunhours-detail-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sunhours-detail-modal";
    overlay.className = "modal-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      `<div class="modal-box"><h2>일조권 검토 — 건물별 상세</h2>` +
      `<div class="modal-body"></div>` +
      `<div class="row"><button class="primary modal-close">닫기</button></div></div>`;
    document.body.appendChild(overlay);
    const el = overlay;
    el.addEventListener("click", (e) => {
      if (e.target === el) el.hidden = true;
    });
    el.querySelector(".modal-close")!.addEventListener("click", () => {
      el.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.hidden) el.hidden = true;
    });
  }
  return { overlay, body: overlay.querySelector(".modal-body")! };
}

/** 건물 하나의 일조 확보율 (벽면+지붕 합산, 0~1). 셀이 없으면 null */
function sunHoursRatio(s: SunHoursBuildingSummary): number | null {
  const total = s.wall.totalCells + s.roof.totalCells;
  if (total === 0) return null;
  return (s.wall.passCells + s.roof.passCells) / total;
}

/** 일조권 건물별 상세를 팝업으로 표시 — 확보율 낮은(불리한) 건물부터 정렬 */
export function showSunHoursDetail(
  summaries: SunHoursBuildingSummary[],
  ruleLabel?: string,
): void {
  const { overlay, body } = ensureSunHoursModal();
  body.innerHTML = "";
  if (ruleLabel) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `판정 기준: ${ruleLabel} — 셀 1개라도 미달이면 "미달"로 집계`;
    body.appendChild(p);
  }
  const sorted = [...summaries]
    .filter((s) => sunHoursRatio(s) !== null)
    .sort((a, b) => sunHoursRatio(a)! - sunHoursRatio(b)!);
  for (const s of sorted) {
    const ratio = sunHoursRatio(s)!;
    const allPass = ratio >= 1 - 1e-9;
    const div = document.createElement("div");
    div.className = "summary-card";
    let html =
      `<div class="bname">${s.name} <b class="${allPass ? "ok" : "bad"}">` +
      `${allPass ? "확보" : "미달"}</b> · 종합 ${(ratio * 100).toFixed(1)}%</div>`;
    for (const [label, f] of [
      ["벽면", s.wall],
      ["지붕", s.roof],
    ] as const) {
      if (f.totalCells === 0) continue;
      const pct = (f.passCells / f.totalCells) * 100;
      const cls = f.passCells === f.totalCells ? "ok" : "";
      html +=
        `<div class="surf-line">${label}: ` +
        `확보 <b class="${cls}">${f.passCells}</b> / ${f.totalCells} (${pct.toFixed(1)}%)</div>`;
    }
    div.innerHTML = html;
    body.appendChild(div);
  }
  overlay.hidden = false;
}

/**
 * 일조권(수인한도) 검토 요약 — 인접건물이 수십 동일 수 있으므로 좌측 패널에는
 * **집계값만** 표시한다: 전체 평균 확보율 + 일조 미달 동수(비율).
 * 건물별 상세(벽면·지붕 확보율)는 "건물별 상세 보기" 버튼 → 팝업으로 확인.
 */
export function renderSunHoursSummary(
  summaries: SunHoursBuildingSummary[] | null,
  ruleLabel?: string,
  note?: string,
): void {
  const root = document.getElementById("sunhours-summary")!;
  root.innerHTML = "";
  if (!summaries) {
    if (note) root.innerHTML = `<p class="hint">${note}</p>`;
    return;
  }
  const withCells = summaries.filter((s) => sunHoursRatio(s) !== null);
  if (withCells.length === 0) {
    root.innerHTML = `<p class="hint">분석 대상(인접건물)이 없습니다.</p>`;
    return;
  }

  let passCells = 0;
  let totalCells = 0;
  for (const s of withCells) {
    passCells += s.wall.passCells + s.roof.passCells;
    totalCells += s.wall.totalCells + s.roof.totalCells;
  }
  const failBldgs = withCells.filter((s) => sunHoursRatio(s)! < 1 - 1e-9);
  const meanRatio =
    withCells.reduce((sum, s) => sum + sunHoursRatio(s)!, 0) / withCells.length;

  const div = document.createElement("div");
  div.className = "summary-card";
  const failPct = ((failBldgs.length / withCells.length) * 100).toFixed(0);
  div.innerHTML =
    `<div class="bname">인접건물 ${withCells.length}동 집계</div>` +
    `<div class="surf-line">평균 확보율: <b class="${meanRatio >= 1 - 1e-9 ? "ok" : ""}">` +
    `${(meanRatio * 100).toFixed(1)}%</b> (전체 셀 기준 ${((passCells / totalCells) * 100).toFixed(1)}%)</div>` +
    `<div class="surf-line">일조 미달: <b class="${failBldgs.length > 0 ? "bad" : "ok"}">` +
    `${failBldgs.length}동</b> / ${withCells.length}동 (${failPct}%)</div>`;
  root.appendChild(div);

  const detailBtn = document.createElement("button");
  detailBtn.textContent = "건물별 상세 보기 (팝업)";
  detailBtn.addEventListener("click", () => showSunHoursDetail(summaries, ruleLabel));
  root.appendChild(detailBtn);

  if (ruleLabel) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `판정 기준: ${ruleLabel}`;
    root.appendChild(p);
  }
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    root.appendChild(p);
  }
}

/** M4 PV 상대평가 요약 — 건물별·면별 상위 셀 면적(㎡)과 상대 효율(%) */
export function renderPvSummary(
  summaries: PvBuildingSummary[] | null,
  note?: string,
): void {
  const root = document.getElementById("pv-summary")!;
  root.innerHTML = "";
  if (!summaries) {
    if (note) root.innerHTML = `<p class="hint">${note}</p>`;
    return;
  }
  if (summaries.length === 0) {
    root.innerHTML = `<p class="hint">분석 대상(인접건물)이 없습니다.</p>`;
    return;
  }
  const topPct = Math.round(PV_TOP_THRESHOLD * 100);
  for (const s of summaries) {
    const div = document.createElement("div");
    div.className = "summary-card";
    let html = `<div class="bname">${s.name}</div>`;
    for (const f of s.faces) {
      const cls = f.meanScorePct >= 50 ? "ok" : "";
      html +=
        `<div class="surf-line">${f.face}: ` +
        `평균 <b class="${cls}">${f.meanScorePct.toFixed(0)}%</b>` +
        ` · 최대 ${f.maxScorePct.toFixed(0)}%` +
        ` · 상위(≥${topPct}%) ${f.topAreaM2.toFixed(1)} / ${f.areaM2.toFixed(1)}㎡</div>`;
    }
    div.innerHTML = html;
    root.appendChild(div);
  }
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    root.appendChild(p);
  }
}

/** M5 PV 절대평가 요약 — 건물별·면별 연간 kWh/m² (면적 가중 평균·최대) */
export function renderPvEnergySummary(
  summaries: PvEnergyBuildingSummary[] | null,
  note?: string,
): void {
  const root = document.getElementById("pv-abs-summary")!;
  root.innerHTML = "";
  if (!summaries) {
    if (note) root.innerHTML = `<p class="hint">${note}</p>`;
    return;
  }
  if (summaries.length === 0) {
    root.innerHTML = `<p class="hint">분석 대상(인접건물)이 없습니다.</p>`;
    return;
  }
  for (const s of summaries) {
    const div = document.createElement("div");
    div.className = "summary-card";
    let html = `<div class="bname">${s.name}</div>`;
    for (const f of s.faces) {
      html +=
        `<div class="surf-line">${f.face}: ` +
        `평균 <b>${f.meanKwh.toFixed(0)}</b> · 최대 ${f.maxKwh.toFixed(0)} kWh/㎡·년` +
        ` (${f.areaM2.toFixed(1)}㎡)</div>`;
    }
    div.innerHTML = html;
    root.appendChild(div);
  }
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    root.appendChild(p);
  }
}

/** M8 바람길 요약 — 주풍향·평균풍속·바람그림자 면적 */
export function renderWindSummary(
  result: WindResult | null,
  note?: string,
): void {
  const root = document.getElementById("wind-summary")!;
  root.innerHTML = "";
  if (!result) {
    if (note) root.innerHTML = `<p class="hint">${note}</p>`;
    return;
  }
  const period = result.month === null ? "연간" : `${result.month}월`;
  const div = document.createElement("div");
  div.className = "summary-card";
  div.innerHTML =
    `<div class="bname">${period} 주풍향 ${windDirLabel(result.windDir)} (${result.windDir.toFixed(0)}°)</div>` +
    `<div class="surf-line">평균 풍속: <b>${result.windSpeedMs.toFixed(1)} m/s</b></div>` +
    `<div class="surf-line">바람그림자(정체, 주풍속 0.3배 미만): ` +
    `<b class="${result.shadowAreaM2 > 0 ? "bad" : "ok"}">${result.shadowAreaM2.toFixed(0)}㎡</b></div>` +
    `<div class="surf-line">스트림라인 ${result.streamlines.length}개</div>`;
  root.appendChild(div);
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    root.appendChild(p);
  }
}

/** M9 일조시간 지도 요약 — 지면 평균·전체 통계·법적기준 참고 판정 */
export function renderSunHoursMapSummary(
  result: SunHoursMapResult | null,
  note?: string,
): void {
  const root = document.getElementById("sunhoursmap-summary")!;
  root.innerHTML = "";
  if (!result) {
    if (note) root.innerHTML = `<p class="hint">${note}</p>`;
    return;
  }
  const n = result.cells.length;
  const groundN = result.cells.filter((c) => c.isGround).length;
  const cont = result.legalCheck.continuous2h;
  const tot = result.legalCheck.total4h;
  const pct = (pass: number) => (n > 0 ? ((pass / n) * 100).toFixed(1) : "0");
  const div = document.createElement("div");
  div.className = "summary-card";
  div.innerHTML =
    `<div class="bname">${result.date} (${result.dates.join(", ")})</div>` +
    `<div class="surf-line">셀 ${n}개 (지면 ${groundN} · 건물 ${n - groundN})</div>` +
    `<div class="surf-line">일조시간: 평균 <b>${result.stats.avg.toFixed(1)}h</b>` +
    ` · 최소 ${result.stats.min.toFixed(1)} · 최대 ${result.stats.max.toFixed(1)}h` +
    (result.groundAvg !== null ? ` · 지면평균 ${result.groundAvg.toFixed(1)}h` : "") +
    `</div>` +
    `<div class="surf-line">연속2h(9~15시, ${result.legalDate}): ` +
    `<b class="${cont.fail === 0 ? "ok" : ""}">${cont.pass}</b>/${n} (${pct(cont.pass)}%)</div>` +
    `<div class="surf-line">총4h(8~16시, ${result.legalDate}): ` +
    `<b class="${tot.fail === 0 ? "ok" : ""}">${tot.pass}</b>/${n} (${pct(tot.pass)}%)</div>`;
  root.appendChild(div);
  if (note) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = note;
    root.appendChild(p);
  }
}

function numberInput(
  value: number,
  min: number,
  max: number,
  step: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

function clampNum(input: HTMLInputElement, min: number, max: number): number {
  let v = parseFloat(input.value);
  if (!isFinite(v)) v = min;
  v = Math.min(max, Math.max(min, v));
  input.value = String(v);
  return v;
}

function labelWrap(text: string, input: HTMLInputElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.append(text, input);
  return label;
}
