import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { pointInPolygon } from "./geom2d";
import { buildingHeight, type Building, type Point2 } from "./types";

/**
 * 지면 그림자 래스터 — 평지 가정의 해석적(2D) 그림자 판정.
 *
 * 각기둥(바닥 b0 ~ 지붕 H)의 지면 그림자 = 지점 p에서 태양 쪽으로 수평거리
 * [b0/tanα, H/tanα] 구간의 선분이 footprint와 만나는 점의 집합(α = 태양 고도).
 * 레이캐스팅보다 수십 배 빨라 일영도·그늘보행권·열쾌적성처럼 넓은 지면을 여러 시각
 * 반복해 볼 때 쓴다. ⚠️ 지형 고저차·지형 자체의 그림자는 무시한다(평지 근사).
 */

export interface ShadowCaster {
  id: string;
  fp: Point2[];
  /** 필로티 높이 (그림자 하단) */
  base: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function shadowCasters(buildings: Building[]): ShadowCaster[] {
  const out: ShadowCaster[] = [];
  for (const b of buildings) {
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    const H = buildingHeight(b);
    const base = Math.min(H, Math.max(0, b.pilotiFloors) * b.floorHeight);
    if (H - base < 0.01) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of fp) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    out.push({ id: b.id, fp, base, height: H, minX, minY, maxX, maxY });
  }
  return out;
}

export interface GroundGrid {
  minX: number;
  minY: number;
  cell: number;
  nx: number;
  ny: number;
}

export function makeGrid(minX: number, minY: number, maxX: number, maxY: number, cell: number): GroundGrid {
  return {
    minX,
    minY,
    cell,
    nx: Math.max(1, Math.ceil((maxX - minX) / cell)),
    ny: Math.max(1, Math.ceil((maxY - minY) / cell)),
  };
}

/** 셀 중심 좌표 */
export function cellCenter(g: GroundGrid, ix: number, iy: number): Point2 {
  return { x: g.minX + (ix + 0.5) * g.cell, y: g.minY + (iy + 0.5) * g.cell };
}

/** three 태양 방향 → 도면 평면 수평 단위벡터(태양 쪽) + tan(고도) */
export function sunPlan(dir: THREE.Vector3): { dx: number; dy: number; tan: number } | null {
  const h = Math.hypot(dir.x, dir.z);
  if (dir.y <= 1e-4 || h < 1e-9) return null;
  return { dx: dir.x / h, dy: -dir.z / h, tan: dir.y / h };
}

function segIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/** 선분이 다각형과 만나는가 (끝점 포함 또는 변 교차) */
export function segmentHitsPolygon(ax: number, ay: number, bx: number, by: number, fp: Point2[]): boolean {
  if (pointInPolygon(ax, ay, fp) || pointInPolygon(bx, by, fp)) return true;
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i];
    const q = fp[(i + 1) % fp.length];
    if (segIntersect(ax, ay, bx, by, p.x, p.y, q.x, q.y)) return true;
  }
  return false;
}

/** 지점 하나가 그림자 속인가 */
export function pointShaded(x: number, y: number, casters: ShadowCaster[], sun: { dx: number; dy: number; tan: number }): boolean {
  for (const c of casters) {
    const r0 = c.base / sun.tan;
    const r1 = c.height / sun.tan;
    const ax = x + sun.dx * r0, ay = y + sun.dy * r0;
    const bx = x + sun.dx * r1, by = y + sun.dy * r1;
    if (Math.max(ax, bx) < c.minX || Math.min(ax, bx) > c.maxX) continue;
    if (Math.max(ay, by) < c.minY || Math.min(ay, by) > c.maxY) continue;
    if (segmentHitsPolygon(ax, ay, bx, by, c.fp)) return true;
  }
  return false;
}

/**
 * 다각형을 셀 중심 기준으로 채운다 (행마다 교차점 짝 사이를 칠함, even-odd).
 */
export function fillPolygon(g: GroundGrid, mask: Uint8Array, pts: Point2[], value = 1): void {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const iy0 = Math.max(0, Math.ceil((minY - g.minY) / g.cell - 0.5));
  const iy1 = Math.min(g.ny - 1, Math.floor((maxY - g.minY) / g.cell - 0.5));
  const xs: number[] = [];
  const n = pts.length;
  for (let iy = iy0; iy <= iy1; iy++) {
    const y = g.minY + (iy + 0.5) * g.cell;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    const row = iy * g.nx;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ix0 = Math.max(0, Math.ceil((xs[k] - g.minX) / g.cell - 0.5));
      const ix1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.minX) / g.cell - 0.5));
      for (let ix = ix0; ix <= ix1; ix++) mask[row + ix] = value;
    }
  }
}

/**
 * 한 시각의 그림자 마스크 (1=그늘). 그림자 영역 = footprint를 태양 반대쪽으로
 * r0~r1만큼 민 자취(민코프스키 합) = 시작·끝 위치의 footprint + 변마다 쓸고 간 사각형.
 * 각각을 행 단위로 채운다. 건물 내부 셀도 1이 될 수 있어 통계에서는 insideMask로 뺀다.
 */
export function shadowMask(g: GroundGrid, casters: ShadowCaster[], dir: THREE.Vector3 | null, out?: Uint8Array): Uint8Array {
  const mask = out ?? new Uint8Array(g.nx * g.ny);
  mask.fill(0);
  const sun = dir ? sunPlan(dir) : null;
  if (!sun) {
    mask.fill(1); // 해가 없으면 전부 그늘
    return mask;
  }
  for (const c of casters) {
    const r0 = c.base / sun.tan;
    const r1 = c.height / sun.tan;
    const ax = -sun.dx * r0, ay = -sun.dy * r0;
    const bx = -sun.dx * r1, by = -sun.dy * r1;
    const fp = c.fp;
    fillPolygon(g, mask, fp.map((p) => ({ x: p.x + ax, y: p.y + ay })));
    fillPolygon(g, mask, fp.map((p) => ({ x: p.x + bx, y: p.y + by })));
    for (let i = 0; i < fp.length; i++) {
      const p = fp[i];
      const q = fp[(i + 1) % fp.length];
      fillPolygon(g, mask, [
        { x: p.x + ax, y: p.y + ay },
        { x: q.x + ax, y: q.y + ay },
        { x: q.x + bx, y: q.y + by },
        { x: p.x + bx, y: p.y + by },
      ]);
    }
  }
  return mask;
}

/** 건물 내부 셀 (1=건물 안) */
export function insideMask(g: GroundGrid, buildings: Building[]): Uint8Array {
  const m = new Uint8Array(g.nx * g.ny);
  for (const b of buildings) {
    const fp = worldFootprint(b);
    if (fp.length >= 3) fillPolygon(g, m, fp);
  }
  return m;
}

/** 닫힌 다각형 하나의 셀 마스크 (예: 대지경계) */
export function polygonMask(g: GroundGrid, pts: Point2[]): Uint8Array {
  const m = new Uint8Array(g.nx * g.ny);
  if (pts.length >= 3) fillPolygon(g, m, pts);
  return m;
}

/**
 * 마칭 스퀘어 — 셀 중심값 field의 level 등치선을 선분 목록으로.
 * 값은 셀 중심에 있다고 보고, 2×2 셀 중심 사각형마다 선형 보간한다.
 */
export function contourSegments(g: GroundGrid, field: Float32Array | Uint8Array, level: number): [Point2, Point2][] {
  const segs: [Point2, Point2][] = [];
  const v = (ix: number, iy: number) => field[iy * g.nx + ix];
  const P = (ix: number, iy: number): Point2 => cellCenter(g, ix, iy);
  const lerp = (a: Point2, b: Point2, va: number, vb: number): Point2 => {
    const t = Math.abs(vb - va) < 1e-12 ? 0.5 : (level - va) / (vb - va);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let iy = 0; iy < g.ny - 1; iy++) {
    for (let ix = 0; ix < g.nx - 1; ix++) {
      const a = v(ix, iy), b = v(ix + 1, iy), c = v(ix + 1, iy + 1), d = v(ix, iy + 1);
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const pa = P(ix, iy), pb = P(ix + 1, iy), pc = P(ix + 1, iy + 1), pd = P(ix, iy + 1);
      const eAB = () => lerp(pa, pb, a, b);
      const eBC = () => lerp(pb, pc, b, c);
      const eCD = () => lerp(pc, pd, c, d);
      const eDA = () => lerp(pd, pa, d, a);
      switch (code) {
        case 1: case 14: segs.push([eDA(), eAB()]); break;
        case 2: case 13: segs.push([eAB(), eBC()]); break;
        case 3: case 12: segs.push([eDA(), eBC()]); break;
        case 4: case 11: segs.push([eBC(), eCD()]); break;
        case 6: case 9: segs.push([eAB(), eCD()]); break;
        case 7: case 8: segs.push([eCD(), eDA()]); break;
        case 5: segs.push([eDA(), eAB()], [eBC(), eCD()]); break;
        case 10: segs.push([eAB(), eBC()], [eCD(), eDA()]); break;
      }
    }
  }
  return segs;
}

/** 선분 묶음 → 지형 위 LineSegments */
export function segmentsToLines(
  segs: [Point2, Point2][],
  color: number,
  elevate: ((x: number, y: number) => number) | undefined,
  lift = 0.3,
): THREE.LineSegments {
  const pos = new Float32Array(segs.length * 6);
  segs.forEach(([a, b], i) => {
    const ya = (elevate ? elevate(a.x, a.y) : 0) + lift;
    const yb = (elevate ? elevate(b.x, b.y) : 0) + lift;
    pos.set([a.x, ya, -a.y, b.x, yb, -b.y], i * 6);
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color }));
}

/**
 * 선분 묶음 → 굵은 띠(지면에 눕힌 사각형) — GL 선 굵기는 1px 고정이라 강조선에 쓴다.
 */
export function segmentsToRibbon(
  segs: [Point2, Point2][],
  color: number,
  width: number,
  elevate: ((x: number, y: number) => number) | undefined,
  lift = 0.35,
): THREE.Mesh {
  const pos: number[] = [];
  const hw = width / 2;
  for (const [a, b] of segs) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const nx = (-dy / L) * hw, ny = (dx / L) * hw;
    const ya = (elevate ? elevate(a.x, a.y) : 0) + lift;
    const yb = (elevate ? elevate(b.x, b.y) : 0) + lift;
    const p1 = [a.x + nx, ya, -(a.y + ny)], p2 = [a.x - nx, ya, -(a.y - ny)];
    const p3 = [b.x - nx, yb, -(b.y - ny)], p4 = [b.x + nx, yb, -(b.y + ny)];
    pos.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
}

/** 지면 셀 히트맵 (값 → 색) — InstancedMesh, 지형 위에 얹음 */
export function gridHeatmap(
  g: GroundGrid,
  colorOf: (k: number) => THREE.Color | null,
  elevate: ((x: number, y: number) => number) | undefined,
  lift = 0.25,
  opacity = 0.8,
): THREE.InstancedMesh {
  const idx: number[] = [];
  const cols: THREE.Color[] = [];
  for (let k = 0; k < g.nx * g.ny; k++) {
    const c = colorOf(k);
    if (c) {
      idx.push(k);
      cols.push(c);
    }
  }
  const geom = new THREE.PlaneGeometry(g.cell, g.cell);
  geom.rotateX(-Math.PI / 2);
  const inst = new THREE.InstancedMesh(
    geom,
    new THREE.MeshBasicMaterial({ transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
    Math.max(1, idx.length),
  );
  const m = new THREE.Matrix4();
  idx.forEach((k, i) => {
    const ix = k % g.nx;
    const iy = Math.floor(k / g.nx);
    const p = cellCenter(g, ix, iy);
    m.makeTranslation(p.x, (elevate ? elevate(p.x, p.y) : 0) + lift, -p.y);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, cols[i]);
  });
  inst.count = idx.length;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}
