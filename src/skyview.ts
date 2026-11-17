import * as THREE from "three";
import { footprintCentroid, worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule, BoardItem } from "./analyses";
import { disposeObject, numInput, pct, selInput } from "./analyses";
import { buildObstructionMeshes, disposeObstructionMeshes } from "./insolation";
import { gradientFromStops } from "./legend";
import { facadePanels } from "./noise";
import { yieldToEventLoop } from "./pv";
import { unitSunPoints } from "./unitsun";
import type { Project } from "./types";

/**
 * 천공률·개방감 — 계획 세대 창(PLAN_WIN × 주거층)에서
 *  - 천공률(%): 창 앞 반구 중 하늘이 보이는 비율. 수직 창의 형태계수(cos 가중)로 계산해,
 *    앞이 완전히 트인 창 = 100%.
 *  - 개방감(%): 눈높이 수평으로 창 정면 ±60° 13방향, 막히는 거리(최대 100m)의 평균 / 100m.
 *  - 정면 거리(m): 창 정면 방향으로 처음 막히는 건물까지 거리.
 */

export interface SkyPoint {
  buildingId: string;
  floor: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  svf: number;
  openness: number;
  frontDist: number;
}

export interface SkyResult {
  points: SkyPoint[];
  buildings: { id: string; name: string; svf: number; openness: number; low: number; n: number; at: THREE.Vector3 }[];
  lowSvf: number;
}

const ELEV = [7.5, 22.5, 37.5, 52.5, 67.5, 82.5];
const AZ = Array.from({ length: 13 }, (_, i) => -90 + i * 15);
const HAZ = Array.from({ length: 13 }, (_, i) => -60 + i * 10);
const FAR = 100;

/** 창 법선 기준 하늘 방향 + 형태계수 가중치 */
export function skyDirections(normal: THREE.Vector3): { dir: THREE.Vector3; w: number }[] {
  const n = new THREE.Vector3(normal.x, 0, normal.z).normalize();
  const side = new THREE.Vector3(-n.z, 0, n.x);
  const out: { dir: THREE.Vector3; w: number }[] = [];
  for (const e of ELEV) {
    const er = THREE.MathUtils.degToRad(e);
    for (const a of AZ) {
      const ar = THREE.MathUtils.degToRad(a);
      const h = Math.cos(er);
      const dir = n.clone().multiplyScalar(h * Math.cos(ar)).addScaledVector(side, h * Math.sin(ar));
      dir.y = Math.sin(er);
      // 입체각 ∝ cos(e), 수직면 형태계수 ∝ cosθ = cos(e)·cos(a)
      out.push({ dir: dir.normalize(), w: Math.cos(er) * Math.cos(er) * Math.max(0, Math.cos(ar)) });
    }
  }
  return out;
}

export async function runSkyView(project: Project, heightM: number, onProgress: (p: number) => void): Promise<SkyResult> {
  const plans = project.buildings.filter((b) => b.type === "계획주동");
  const pts = plans.flatMap((b) => unitSunPoints(b, heightM));
  if (pts.length === 0) throw new Error("계획주동에 창 표시(PLAN_WIN)가 없습니다");
  const meshes = buildObstructionMeshes(project.buildings);
  const rc = new THREE.Raycaster();
  (rc as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
  const points: SkyPoint[] = [];
  const o = new THREE.Vector3();
  try {
    const CHUNK = 100;
    for (let i = 0; i < pts.length; i += CHUNK) {
      const end = Math.min(pts.length, i + CHUNK);
      for (let k = i; k < end; k++) {
        const p = pts[k];
        o.copy(p.position).addScaledVector(p.normal, 0.3);
        let vis = 0, tot = 0;
        rc.far = 500;
        for (const s of skyDirections(p.normal)) {
          rc.set(o, s.dir);
          tot += s.w;
          if (rc.intersectObjects(meshes, false).length === 0) vis += s.w;
        }
        const n = new THREE.Vector3(p.normal.x, 0, p.normal.z).normalize();
        let sum = 0, front = FAR;
        rc.far = FAR;
        for (const a of HAZ) {
          const dir = n.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(a));
          rc.set(o, dir);
          const hit = rc.intersectObjects(meshes, false)[0];
          const d = hit ? hit.distance : FAR;
          sum += d;
          if (a === 0) front = d;
        }
        points.push({ ...p, svf: tot > 0 ? vis / tot : 0, openness: sum / HAZ.length / FAR, frontDist: front });
      }
      onProgress((end / pts.length) * 100);
      if (end < pts.length) await yieldToEventLoop();
    }
  } finally {
    disposeObstructionMeshes(meshes);
  }
  const LOW = 0.3;
  const buildings: SkyResult["buildings"] = [];
  for (const b of plans) {
    const mine = points.filter((p) => p.buildingId === b.id);
    if (!mine.length) continue;
    const c = footprintCentroid(worldFootprint(b));
    buildings.push({
      id: b.id,
      name: b.name,
      svf: mine.reduce((s, p) => s + p.svf, 0) / mine.length,
      openness: mine.reduce((s, p) => s + p.openness, 0) / mine.length,
      low: mine.filter((p) => p.svf < LOW).length,
      n: mine.length,
      at: new THREE.Vector3(c.x, (b.terrainElevation ?? 0) + (b.floors * b.floorHeight) / 2, -c.y),
    });
  }
  return { points, buildings, lowSvf: points.filter((p) => p.svf < LOW).length };
}

export const RATIO_COLOR_STOPS: [number, number][] = [
  [0, 0xb91c1c],
  [0.25, 0xf97316],
  [0.5, 0xfacc15],
  [0.75, 0x84cc16],
  [1, 0x16a34a],
];

export function ratioColor(v: number, out = new THREE.Color()): THREE.Color {
  for (let i = 1; i < RATIO_COLOR_STOPS.length; i++) {
    if (v <= RATIO_COLOR_STOPS[i][0]) {
      const [v0, c0] = RATIO_COLOR_STOPS[i - 1];
      const [v1, c1] = RATIO_COLOR_STOPS[i];
      return out.set(c0).lerp(new THREE.Color(c1), Math.max(0, (v - v0) / (v1 - v0)));
    }
  }
  return out.set(RATIO_COLOR_STOPS[RATIO_COLOR_STOPS.length - 1][1]);
}

export function createSkyViewModule(ctx: AnalysisContext): AnalysisModule {
  let result: SkyResult | null = null;
  let overlay: THREE.Object3D | null = null;
  let shown: "svf" | "openness" = "svf";
  const avg = (k: "svf" | "openness") => result!.points.reduce((s, p) => s + p[k], 0) / result!.points.length;
  const draw = () => {
    disposeObject(overlay);
    overlay = facadePanels(
      result!.points.map((p) => ({ position: p.position, normal: p.normal, color: ratioColor(p[shown]) })),
      "skyview",
    );
    ctx.viewer.scene.add(overlay);
  };
  return {
    id: "skyview",
    slot: "env",
    title: "천공률·개방감",
    hint: "계획 세대 창에서 하늘이 보이는 비율(천공률)과 수평 시야가 트인 정도(개방감)",
    settingsHtml: `
      <div class="row"><label for="skyview-show">색 표시</label>
        <select id="skyview-show">
          <option value="svf" selected>천공률</option>
          <option value="openness">개방감</option>
        </select></div>
      <div class="row"><label for="skyview-height">측정 높이(바닥+m)</label>
        <input type="number" id="skyview-height" value="1.2" min="0" max="3" step="0.1" /></div>
      <p class="hint">천공률 30% 미만 창을 "답답한 창"으로 셉니다. 개방감은 정면 ±60° 수평 시야 100m 기준.</p>`,
    async run(onProgress) {
      shown = selInput("skyview-show", "svf") as "svf" | "openness";
      result = await runSkyView(ctx.project, numInput("skyview-height", 1.2, 0, 3), onProgress);
      draw();
      return `천공률 평균 ${(avg("svf") * 100).toFixed(1)}% · 개방감 평균 ${(avg("openness") * 100).toFixed(1)}% · 천공률 30% 미만 ${result.lowSvf}세대`;
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    setVisible(on: boolean) {
      if (overlay) overlay.visible = on;
    },
    summaryHtml() {
      const r = result!;
      return (
        `<div class="hint">천공률 평균 <b>${(avg("svf") * 100).toFixed(1)}%</b> · 개방감 평균 <b>${(avg("openness") * 100).toFixed(1)}%</b></div>` +
        `<div class="hint">천공률 30% 미만 ${r.lowSvf} / ${r.points.length}세대 (${pct(r.lowSvf, r.points.length)})</div>`
      );
    },
    legends() {
      return [
        {
          kind: "gradient",
          title: shown === "svf" ? "천공률 (창에서 보이는 하늘)" : "개방감 (정면 ±60° 수평 시야)",
          stops: gradientFromStops(RATIO_COLOR_STOPS, 1),
          ticks: [0, 0.25, 0.5, 0.75, 1].map((v) => ({ at: v, label: `${v * 100}%` })),
          note: `평균 천공률 ${(avg("svf") * 100).toFixed(1)}% · 개방감 ${(avg("openness") * 100).toFixed(1)}%`,
        },
      ];
    },
    board() {
      const r = result!;
      const items: BoardItem[] = [...r.buildings]
        .sort((a, b) => a.svf - b.svf)
        .map((b) => ({
          label: `${b.name} — 천공률 ${(b.svf * 100).toFixed(0)}% · 개방감 ${(b.openness * 100).toFixed(0)}% · 30% 미만 ${b.low}`,
          verdict: b.low > 0 ? "warn" : "ok",
          at: b.at,
        }));
      return {
        title: "천공률·개방감",
        value: `천공률 ${(avg("svf") * 100).toFixed(1)}% · 개방감 ${(avg("openness") * 100).toFixed(1)}% · 30% 미만 ${r.lowSvf}세대`,
        verdict: r.lowSvf > 0 ? "warn" : "ok",
        items,
      };
    },
    excel() {
      const r = result!;
      const name = new Map(r.buildings.map((b) => [b.id, b.name]));
      return {
        name: "천공률·개방감",
        rows: [
          ["천공률·개방감", "천공률 = 수직 창 형태계수 가중 하늘 비율 · 개방감 = 정면 ±60° 수평 시야(100m) 평균"],
          [],
          ["동", "측정 세대", "평균 천공률", "평균 개방감", "천공률 30% 미만"],
          ...r.buildings.map((b) => [b.name, b.n, pct(b.svf, 1), pct(b.openness, 1), b.low]),
          [],
          ["동", "층", "천공률(%)", "개방감(%)", "정면 거리(m)"],
          ...r.points.map((p) => [
            name.get(p.buildingId) ?? "",
            p.floor,
            Math.round(p.svf * 1000) / 10,
            Math.round(p.openness * 1000) / 10,
            Math.round(p.frontDist * 10) / 10,
          ]),
        ],
        widths: [16, 10, 12, 12, 14],
      };
    },
  };
}
