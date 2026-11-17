import * as THREE from "three";
import type { ShadowCaster } from "./groundshadow";
import type { Canopy, Point2, Project, Tree } from "./types";

/**
 * 가로 시설물 — 차양(그늘막)과 가로수. 그늘 계산용 그림자 장애물과 3D 표시를 만든다.
 * 그늘보행권·일영도·열쾌적성이 함께 쓴다.
 */

type Elev = ((x: number, y: number) => number) | undefined;

/** 차양 판 두께 (m) */
export const CANOPY_T = 0.15;

/** 차양 → 바닥 사각형 (a→b 중심선, 폭 width) */
export function canopyFootprint(c: Canopy): Point2[] {
  const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (c.width / 2), ny = (dx / L) * (c.width / 2);
  return [
    { x: c.a.x + nx, y: c.a.y + ny },
    { x: c.b.x + nx, y: c.b.y + ny },
    { x: c.b.x - nx, y: c.b.y - ny },
    { x: c.a.x - nx, y: c.a.y - ny },
  ];
}

function caster(id: string, fp: Point2[], base: number, height: number, gl: number): ShadowCaster {
  return {
    id,
    fp,
    base,
    height,
    gl,
    minX: Math.min(...fp.map((p) => p.x)),
    minY: Math.min(...fp.map((p) => p.y)),
    maxX: Math.max(...fp.map((p) => p.x)),
    maxY: Math.max(...fp.map((p) => p.y)),
  };
}

export function canopyCasters(canopies: Canopy[], elevate?: Elev): ShadowCaster[] {
  return canopies.map((c) => {
    const mx = (c.a.x + c.b.x) / 2, my = (c.a.y + c.b.y) / 2;
    return caster(c.id, canopyFootprint(c), Math.max(0, c.height - CANOPY_T), c.height, elevate ? elevate(mx, my) : 0);
  });
}

/** 수관 8각형 */
export function treeFootprint(t: Tree): Point2[] {
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { x: t.p.x + t.radius * Math.cos(a), y: t.p.y + t.radius * Math.sin(a) };
  });
}

export function treeCasters(trees: Tree[], elevate?: Elev): ShadowCaster[] {
  return trees.map((t) =>
    caster(t.id, treeFootprint(t), Math.min(t.crownBase, t.height - 0.5), t.height, elevate ? elevate(t.p.x, t.p.y) : 0),
  );
}

/** 프로젝트의 차양 + 가로수 그림자 장애물 */
export function streetCasters(project: Project, elevate?: Elev): ShadowCaster[] {
  return [...canopyCasters(project.canopies ?? [], elevate), ...treeCasters(project.trees ?? [], elevate)];
}

/** 두 점 사이에 간격 spacing으로 나무 위치 (양 끝 포함) */
export function treeLine(a: Point2, b: Point2, spacing: number): Point2[] {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.round(L / Math.max(1, spacing)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

/** 차양(기둥 2개 + 판)·가로수(줄기 + 수관) 3D — 그림자를 드리운다 */
export function createStreetGroup(project: Project, elevate: Elev): THREE.Group {
  const g = new THREE.Group();
  g.name = "streetscape";
  const slabMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const postMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  for (const c of project.canopies ?? []) {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 0.1) continue;
    const mx = (c.a.x + c.b.x) / 2, my = (c.a.y + c.b.y) / 2;
    const gl = elevate ? elevate(mx, my) : 0;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(L, CANOPY_T, c.width), slabMat);
    slab.position.set(mx, gl + c.height - CANOPY_T / 2, -my);
    slab.rotation.y = Math.atan2(dy, dx);
    slab.castShadow = true;
    slab.receiveShadow = true;
    g.add(slab);
    for (const p of [c.a, c.b]) {
      const pg = elevate ? elevate(p.x, p.y) : 0;
      const h = Math.max(0.5, gl + c.height - pg);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.2), postMat);
      post.position.set(p.x, pg + h / 2, -p.y);
      post.castShadow = true;
      g.add(post);
    }
  }
  const trees = project.trees ?? [];
  if (trees.length) {
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7c5a3a });
    const crownMat = new THREE.MeshLambertMaterial({ color: 0x4f8a4a });
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 1, 8);
    const crownGeo = new THREE.SphereGeometry(1, 14, 10);
    for (const t of trees) {
      const gl = elevate ? elevate(t.p.x, t.p.y) : 0;
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      const tb = Math.max(0.5, t.crownBase);
      trunk.scale.set(1, tb + 0.5, 1);
      trunk.position.set(t.p.x, gl + (tb + 0.5) / 2, -t.p.y);
      trunk.castShadow = true;
      const crown = new THREE.Mesh(crownGeo, crownMat);
      const ch = Math.max(0.5, t.height - t.crownBase);
      crown.scale.set(t.radius, ch / 2, t.radius);
      crown.position.set(t.p.x, gl + t.crownBase + ch / 2, -t.p.y);
      crown.castShadow = true;
      crown.receiveShadow = true;
      g.add(trunk, crown);
    }
  }
  return g;
}
