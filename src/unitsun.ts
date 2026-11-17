import * as THREE from "three";
import { footprintCentroid, worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule, BoardItem } from "./analyses";
import { disposeObject, numInput, pct, selInput } from "./analyses";
import { windowAnchors } from "./facility";
import { buildObstructionMeshes, disposeObstructionMeshes } from "./insolation";
import { yieldToEventLoop } from "./pv";
import { sunSamples } from "./sun";
import { pointSunHours } from "./sunhours";
import type { Building } from "./types";

/**
 * 계획 세대 일조 확보율 — 계획주동의 창(PLAN_WIN)마다, 주거층(필로티 제외)마다 측정점을 두고
 * 기준일(기본 동지) 연속·총 일조시간을 계산해 "기준을 넘는 세대 비율"을 동별·단지 전체로 낸다.
 * 창 표시 1개 × 층 1개 = 세대 1개로 근사한다(창 표시를 세대마다 하나씩 그리는 규약).
 * 인접건물 피해(sunhours.ts·facility.ts)와 반대로 "우리 단지가 받는 일조"를 본다.
 */

export type UnitSunRule = "continuous" | "total" | "either";

export interface UnitSunPoint {
  buildingId: string;
  floor: number;
  window: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  continuous: number;
  total: number;
  pass: boolean;
}

export interface UnitSunBuilding {
  buildingId: string;
  name: string;
  points: number;
  pass: number;
  /** 동 중심 (three 좌표, 중간 높이) — 결과판 이동용 */
  center: THREE.Vector3;
}

export interface UnitSunResult {
  date: string;
  rule: UnitSunRule;
  targetRatio: number;
  points: UnitSunPoint[];
  buildings: UnitSunBuilding[];
  noWindows: string[];
}

export function unitSunPasses(rule: UnitSunRule, continuous: number, total: number): boolean {
  const c = continuous >= 2 - 1e-6;
  const t = total >= 4 - 1e-6;
  return rule === "continuous" ? c : rule === "total" ? t : c || t;
}

export const UNIT_RULE_LABEL: Record<UnitSunRule, string> = {
  continuous: "연속 2h(9~15시)",
  total: "총 4h(8~16시)",
  either: "연속 2h 또는 총 4h",
};

/** 측정점 목록 — 주거층(필로티 위)만, 층 바닥 + 측정 높이 */
export function unitSunPoints(b: Building, heightM: number): Omit<UnitSunPoint, "continuous" | "total" | "pass">[] {
  const anchors = windowAnchors(b);
  const out: Omit<UnitSunPoint, "continuous" | "total" | "pass">[] = [];
  const gl = b.terrainElevation ?? 0;
  const from = Math.min(b.floors, Math.max(0, b.pilotiFloors)) + 1;
  for (let f = from; f <= b.floors; f++) {
    const y = gl + (f - 1) * b.floorHeight + Math.min(heightM, b.floorHeight - 0.05);
    anchors.forEach((an, wi) => {
      out.push({
        buildingId: b.id,
        floor: f,
        window: wi + 1,
        position: new THREE.Vector3(an.mid.x, y, -an.mid.y),
        normal: new THREE.Vector3(an.n.x, 0, -an.n.y),
      });
    });
  }
  return out;
}

export async function runUnitSun(
  ctx: AnalysisContext,
  rule: UnitSunRule,
  targetRatio: number,
  heightM: number,
  onProgress: (pct: number) => void,
): Promise<UnitSunResult> {
  const { project } = ctx;
  const { site, analysis, buildings } = project;
  const step = analysis.sunHours.timeStep;
  const samples = sunSamples(analysis.date, site.latitude, site.longitude, site.northAngle, 480, 960 - step, step);
  const plans = buildings.filter((b) => b.type === "계획주동");
  const noWindows: string[] = [];
  const points: UnitSunPoint[] = [];
  for (const b of plans) {
    const pts = unitSunPoints(b, heightM);
    if (pts.length === 0) {
      noWindows.push(b.name);
      continue;
    }
    for (const p of pts) points.push({ ...p, continuous: 0, total: 0, pass: false });
  }
  const meshes = buildObstructionMeshes(buildings);
  try {
    const CHUNK = 150;
    for (let i = 0; i < points.length; i += CHUNK) {
      const end = Math.min(points.length, i + CHUNK);
      for (let k = i; k < end; k++) {
        const p = points[k];
        const h = pointSunHours(samples, step, p.position, p.normal, meshes);
        p.continuous = h.continuous;
        p.total = h.total;
        p.pass = unitSunPasses(rule, h.continuous, h.total);
      }
      onProgress((end / Math.max(1, points.length)) * 100);
      if (end < points.length) await yieldToEventLoop();
    }
  } finally {
    disposeObstructionMeshes(meshes);
  }
  const summaries: UnitSunBuilding[] = [];
  for (const b of plans) {
    const mine = points.filter((p) => p.buildingId === b.id);
    if (mine.length === 0) continue;
    const c = footprintCentroid(worldFootprint(b));
    const gl = b.terrainElevation ?? 0;
    summaries.push({
      buildingId: b.id,
      name: b.name,
      points: mine.length,
      pass: mine.filter((p) => p.pass).length,
      center: new THREE.Vector3(c.x, gl + (b.floors * b.floorHeight) / 2, -c.y),
    });
  }
  return { date: analysis.date, rule, targetRatio, points, buildings: summaries, noWindows };
}

const PASS = 0x4c8bf5;
const FAIL = 0xe5484d;

export function createUnitSunOverlay(points: UnitSunPoint[]): THREE.Group {
  const g = new THREE.Group();
  g.name = "unit-sun";
  const geom = new THREE.BoxGeometry(1.4, 1.0, 0.15);
  for (const [pass, color] of [[true, PASS], [false, FAIL]] as const) {
    const mine = points.filter((p) => p.pass === pass);
    if (mine.length === 0) continue;
    const inst = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial({ color }), mine.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    const one = new THREE.Vector3(1, 1, 1);
    mine.forEach((p, i) => {
      q.setFromUnitVectors(z, p.normal);
      m.compose(p.position.clone().addScaledVector(p.normal, 0.2), q, one);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
  }
  return g;
}

export function createUnitSunModule(ctx: AnalysisContext): AnalysisModule {
  let result: UnitSunResult | null = null;
  let overlay: THREE.Group | null = null;
  const total = () => result!.points.length;
  const passed = () => result!.points.filter((p) => p.pass).length;
  return {
    id: "unitsun",
    slot: "sun",
    title: "계획 세대 일조 확보율",
    hint: "계획주동 창(PLAN_WIN) × 주거층마다 기준일 일조시간 — 창 1개·층 1개 = 세대 1개로 근사",
    settingsHtml: `
      <div class="row"><label for="unitsun-rule">판정 기준</label>
        <select id="unitsun-rule">
          <option value="continuous" selected>연속 2h(9~15시)</option>
          <option value="total">총 4h(8~16시)</option>
          <option value="either">연속 2h 또는 총 4h</option>
        </select></div>
      <div class="row"><label for="unitsun-target">목표 확보율(%)</label>
        <input type="number" id="unitsun-target" value="50" min="1" max="100" step="5" /></div>
      <div class="row"><label for="unitsun-height">측정 높이(바닥+m)</label>
        <input type="number" id="unitsun-height" value="1.2" min="0" max="3" step="0.1" /></div>
      <p class="hint">기준일은 상단 날짜(기본 동지)를 따릅니다.</p>`,
    async run(onProgress) {
      const rule = selInput("unitsun-rule", "continuous") as UnitSunRule;
      const target = numInput("unitsun-target", 50, 1, 100) / 100;
      const height = numInput("unitsun-height", 1.2, 0, 3);
      result = await runUnitSun(ctx, rule, target, height, onProgress);
      if (result.points.length === 0) {
        const r = result;
        result = null;
        throw new Error(
          r.noWindows.length > 0
            ? `계획주동에 창 표시(PLAN_WIN)가 없습니다 (${r.noWindows.length}동)`
            : "계획주동이 없습니다",
        );
      }
      overlay = createUnitSunOverlay(result.points);
      ctx.viewer.scene.add(overlay);
      return `계획 세대 일조 확보율 ${pct(passed(), total())} — ${UNIT_RULE_LABEL[rule]} (${result.date})`;
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    summaryHtml() {
      const r = result!;
      const under = r.buildings.filter((b) => b.pass / b.points < r.targetRatio - 1e-9);
      return (
        `<div class="an-big">${pct(passed(), total())}</div>` +
        `<div class="hint">확보 ${passed()} / ${total()}세대 · ${UNIT_RULE_LABEL[r.rule]}</div>` +
        `<div class="hint">목표 ${Math.round(r.targetRatio * 100)}% 미만 ${under.length}동` +
        (r.noWindows.length ? ` · 창 표시 없음 ${r.noWindows.length}동` : "") +
        `</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "swatches",
          title: `계획 세대 일조 — ${UNIT_RULE_LABEL[r.rule]}`,
          items: [
            { color: "#4c8bf5", label: "확보 세대" },
            { color: "#e5484d", label: "미달 세대" },
          ],
          note: `확보율 ${pct(passed(), total())} (${passed()}/${total()}) · 기준일 ${r.date}`,
        },
      ];
    },
    board() {
      const r = result!;
      const ratio = passed() / total();
      const items: BoardItem[] = [...r.buildings]
        .sort((a, b) => a.pass / a.points - b.pass / b.points)
        .map((b) => ({
          label: `${b.name} ${pct(b.pass, b.points)} (${b.pass}/${b.points})`,
          verdict: b.pass / b.points >= r.targetRatio - 1e-9 ? "ok" : "bad",
          at: b.center,
        }));
      return {
        title: "계획 세대 일조 확보율",
        value: `${pct(passed(), total())} · 목표 ${Math.round(r.targetRatio * 100)}%`,
        verdict: ratio >= r.targetRatio - 1e-9 ? "ok" : "bad",
        items,
      };
    },
    excel() {
      const r = result!;
      const name = new Map(r.buildings.map((b) => [b.buildingId, b.name]));
      const rows: (string | number | null)[][] = [
        ["계획 세대 일조 확보율", `${UNIT_RULE_LABEL[r.rule]} · 기준일 ${r.date}`],
        ["전체", `${passed()} / ${total()}`, pct(passed(), total())],
        [],
        ["동", "측정 세대", "확보", "확보율"],
        ...r.buildings.map((b) => [b.name, b.points, b.pass, pct(b.pass, b.points)]),
        [],
        ["동", "층", "창", "연속(h)", "총(h)", "판정"],
        ...r.points.map((p) => [
          name.get(p.buildingId) ?? "",
          p.floor,
          p.window,
          Math.round(p.continuous * 100) / 100,
          Math.round(p.total * 100) / 100,
          p.pass ? "확보" : "미달",
        ]),
      ];
      return { name: "세대 일조 확보율", rows, widths: [16, 10, 8, 10, 10, 8] };
    },
  };
}
