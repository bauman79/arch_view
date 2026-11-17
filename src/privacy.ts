import * as THREE from "three";
import { worldFootprint } from "./buildings";
import type { AnalysisContext, AnalysisModule, BoardItem } from "./analyses";
import { chkInput, disposeObject, numInput } from "./analyses";
import { windowAnchors } from "./facility";
import { segmentHitsPolygon } from "./groundshadow";
import type { Building, Point2, Project } from "./types";

/**
 * 세대 간 시선 간섭 — 서로 마주 보는 창(계획주동 PLAN_WIN, 선택 시 인접건물 ADJ_WIN)끼리
 * 수평거리가 가깝고(기본 20m 이내) 두 창이 서로를 정면 ±60° 안에서 바라보며 사이에
 * 다른 건물이 없으면 "시선 간섭"으로 본다. 두 동의 주거층이 겹치는 층마다 1쌍씩 센다
 * (같은 층 높이에서 서로 들여다보임).
 * 등급: 10m 미만 심각 · 10~15m 주의 · 15m~기준 경미.
 */

export type PrivacyLevel = "severe" | "caution" | "minor";

export const PRIVACY_LABEL: Record<PrivacyLevel, string> = {
  severe: "심각 (10m 미만)",
  caution: "주의 (10~15m)",
  minor: "경미 (15m~기준)",
};

export const PRIVACY_COLOR: Record<PrivacyLevel, number> = {
  severe: 0xdc2626,
  caution: 0xf97316,
  minor: 0xfacc15,
};

export interface PrivacyPair {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  pa: Point2;
  pb: Point2;
  distance: number;
  floors: number[];
  level: PrivacyLevel;
}

export interface PrivacyResult {
  maxDist: number;
  pairs: PrivacyPair[];
  /** 간섭 세대 쌍 수 (쌍 × 겹치는 층) */
  unitPairs: Record<PrivacyLevel, number>;
}

export function privacyLevel(d: number): PrivacyLevel {
  return d < 10 ? "severe" : d < 15 ? "caution" : "minor";
}

function residentialFloors(b: Building): [number, number] {
  return [Math.min(b.floors, Math.max(0, b.pilotiFloors)) + 1, b.floors];
}

export function runPrivacy(project: Project, maxDist: number, includeAdj: boolean, halfAngleDeg = 60): PrivacyResult {
  const cosLim = Math.cos(THREE.MathUtils.degToRad(halfAngleDeg));
  const targets = project.buildings.filter(
    (b) => (b.type === "계획주동" || includeAdj) && b.windowSegments.length > 0,
  );
  const wins = targets.flatMap((b) => windowAnchors(b).map((w) => ({ b, ...w })));
  const fps = new Map(project.buildings.map((b) => [b.id, worldFootprint(b)]));
  const pairs: PrivacyPair[] = [];
  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      const A = wins[i], B = wins[j];
      if (A.b.id === B.b.id) continue;
      if (A.b.type !== "계획주동" && B.b.type !== "계획주동") continue; // 인접건물끼리는 제외
      const dx = B.mid.x - A.mid.x, dy = B.mid.y - A.mid.y;
      const d = Math.hypot(dx, dy);
      if (d > maxDist || d < 1e-6) continue;
      const ux = dx / d, uy = dy / d;
      if (A.n.x * ux + A.n.y * uy < cosLim) continue;
      if (-(B.n.x * ux + B.n.y * uy) < cosLim) continue;
      // 사이를 막는 다른 건물 (두 동 자신은 창이 벽 위라 제외, 끝점은 벽에서 0.3m 띄움)
      const a2 = { x: A.mid.x + A.n.x * 0.3, y: A.mid.y + A.n.y * 0.3 };
      const b2 = { x: B.mid.x + B.n.x * 0.3, y: B.mid.y + B.n.y * 0.3 };
      let blocked = false;
      for (const [id, fp] of fps) {
        if (id === A.b.id || id === B.b.id) continue;
        if (segmentHitsPolygon(a2.x, a2.y, b2.x, b2.y, fp)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const [a0, a1] = residentialFloors(A.b);
      const [b0, b1] = residentialFloors(B.b);
      // 층 높이가 같은 쌍 — 지반고·층고 차이를 반영해 같은 높이(±층고/2)의 층끼리 짝짓기
      const floors: number[] = [];
      const gA = A.b.terrainElevation ?? 0, gB = B.b.terrainElevation ?? 0;
      for (let f = a0; f <= a1; f++) {
        const z = gA + (f - 0.5) * A.b.floorHeight;
        const fb = Math.round((z - gB) / B.b.floorHeight + 0.5);
        if (fb >= b0 && fb <= b1) floors.push(f);
      }
      if (floors.length === 0) continue;
      pairs.push({
        aId: A.b.id, aName: A.b.name, bId: B.b.id, bName: B.b.name,
        pa: A.mid, pb: B.mid, distance: d, floors, level: privacyLevel(d),
      });
    }
  }
  const unitPairs: Record<PrivacyLevel, number> = { severe: 0, caution: 0, minor: 0 };
  for (const p of pairs) unitPairs[p.level] += p.floors.length;
  return { maxDist, pairs, unitPairs };
}

export function createPrivacyOverlay(r: PrivacyResult, project: Project): THREE.Group {
  const g = new THREE.Group();
  g.name = "privacy";
  const byId = new Map(project.buildings.map((b) => [b.id, b]));
  for (const lv of ["severe", "caution", "minor"] as PrivacyLevel[]) {
    const pos: number[] = [];
    for (const p of r.pairs.filter((x) => x.level === lv)) {
      const A = byId.get(p.aId)!;
      const gA = A.terrainElevation ?? 0;
      for (const f of p.floors) {
        const y = gA + (f - 0.5) * A.floorHeight;
        pos.push(p.pa.x, y, -p.pa.y, p.pb.x, y, -p.pb.y);
      }
    }
    if (!pos.length) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: PRIVACY_COLOR[lv] })));
  }
  return g;
}

export function createPrivacyModule(ctx: AnalysisContext): AnalysisModule {
  let result: PrivacyResult | null = null;
  let overlay: THREE.Object3D | null = null;
  const order: PrivacyLevel[] = ["severe", "caution", "minor"];
  const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
  return {
    id: "privacy",
    slot: "env",
    title: "세대 간 시선 간섭",
    hint: "마주 보는 창(PLAN_WIN)끼리 거리·각도·가림으로 들여다보이는 세대 쌍을 찾습니다",
    runLabel: "검토 실행",
    settingsHtml: `
      <div class="row"><label for="privacy-dist">검토 거리(m)</label>
        <input type="number" id="privacy-dist" value="20" min="5" max="60" step="1" /></div>
      <div class="row"><label for="privacy-angle">정면 시야 반각(°)</label>
        <input type="number" id="privacy-angle" value="60" min="15" max="85" step="5" /></div>
      <div class="row"><label><input type="checkbox" id="privacy-adj" /> 인접건물 창(ADJ_WIN)도 포함</label></div>`,
    async run() {
      result = runPrivacy(
        ctx.project,
        numInput("privacy-dist", 20, 5, 60),
        chkInput("privacy-adj", false),
        numInput("privacy-angle", 60, 15, 85),
      );
      if (ctx.project.buildings.every((b) => b.type !== "계획주동" || b.windowSegments.length === 0)) {
        result = null;
        throw new Error("계획주동에 창 표시(PLAN_WIN)가 없습니다");
      }
      overlay = createPrivacyOverlay(result, ctx.project);
      ctx.viewer.scene.add(overlay);
      const u = result.unitPairs;
      return `시선 간섭 — 심각 ${u.severe} · 주의 ${u.caution} · 경미 ${u.minor} 세대 쌍 (창 쌍 ${result.pairs.length})`;
    },
    clear() {
      result = null;
      disposeObject(overlay);
      overlay = null;
    },
    hasResult: () => result !== null,
    summaryHtml() {
      const r = result!;
      return (
        order
          .map((l) => `<div class="hint"><span style="color:${hex(PRIVACY_COLOR[l])}">■</span> ${PRIVACY_LABEL[l]} ${r.unitPairs[l]}세대 쌍</div>`)
          .join("") + `<div class="hint">마주 보는 창 쌍 ${r.pairs.length}개 (층마다 1세대 쌍)</div>`
      );
    },
    legends() {
      const r = result!;
      return [
        {
          kind: "swatches",
          title: `세대 간 시선 간섭 (${r.maxDist}m 이내)`,
          items: order.map((l) => ({ color: hex(PRIVACY_COLOR[l]), label: `${PRIVACY_LABEL[l].split(" ")[0]} ${r.unitPairs[l]}` })),
          note: "선 = 서로 들여다보이는 창 (겹치는 층마다)",
        },
      ];
    },
    board() {
      const r = result!;
      const byPair = new Map<string, { label: string; worst: PrivacyLevel; n: number; at: THREE.Vector3 }>();
      for (const p of r.pairs) {
        const key = [p.aName, p.bName].sort().join(" ↔ ");
        const cur = byPair.get(key);
        const at = new THREE.Vector3((p.pa.x + p.pb.x) / 2, 15, -(p.pa.y + p.pb.y) / 2);
        if (!cur) byPair.set(key, { label: key, worst: p.level, n: p.floors.length, at });
        else {
          cur.n += p.floors.length;
          if (order.indexOf(p.level) < order.indexOf(cur.worst)) cur.worst = p.level;
        }
      }
      const items: BoardItem[] = [...byPair.values()]
        .sort((a, b) => order.indexOf(a.worst) - order.indexOf(b.worst) || b.n - a.n)
        .map((x) => ({
          label: `${x.label} — ${PRIVACY_LABEL[x.worst].split(" ")[0]} · ${x.n}세대 쌍`,
          verdict: x.worst === "severe" ? "bad" : x.worst === "caution" ? "warn" : "info",
          at: x.at,
        }));
      return {
        title: "세대 간 시선 간섭",
        value: `심각 ${r.unitPairs.severe} · 주의 ${r.unitPairs.caution} · 경미 ${r.unitPairs.minor} 세대 쌍`,
        verdict: r.unitPairs.severe > 0 ? "bad" : r.unitPairs.caution > 0 ? "warn" : "ok",
        items,
      };
    },
    excel() {
      const r = result!;
      return {
        name: "시선 간섭",
        rows: [
          ["세대 간 시선 간섭", `검토 거리 ${r.maxDist}m · 서로 정면 시야 안 · 사이 건물 없음 · 겹치는 층마다 1세대 쌍`],
          [],
          ["창 A 동", "창 B 동", "거리(m)", "등급", "겹치는 층", "세대 쌍"],
          ...r.pairs
            .sort((a, b) => a.distance - b.distance)
            .map((p) => [
              p.aName,
              p.bName,
              Math.round(p.distance * 10) / 10,
              PRIVACY_LABEL[p.level],
              `${p.floors[0]}~${p.floors[p.floors.length - 1]}층`,
              p.floors.length,
            ]),
        ],
        widths: [16, 16, 10, 16, 12, 10],
      };
    },
  };
}
