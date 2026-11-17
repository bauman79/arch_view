import * as THREE from "three";
import type { Point2 } from "./types";

/**
 * 지형 표면에 정확히 얹기 — 다각형을 지형 삼각형(TIN 또는 계단식 단 판)마다 잘라
 * 그 삼각형의 평면 높이를 그대로 쓴다. 채움면을 별도 점 격자로 삼각분할해 얹으면
 * 지형 삼각형 사이에서 채움면이 지형 속으로 파고들어 얼룩(z-fighting)이 생긴다.
 */

export interface DrapeSurface {
  /** 삼각형 9개씩 (x, y, z) × 3 — 도면 좌표, z = 고도 */
  tris: Float64Array;
  minX: number;
  minY: number;
  cell: number;
  nx: number;
  ny: number;
  cells: (number[] | undefined)[];
}

export function makeSurface(tris: Float64Array): DrapeSurface {
  const n = tris.length / 9;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
    minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
  }
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  const cell = Math.max(1, Math.sqrt(area / Math.max(1, n)) * 2);
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const cells: (number[] | undefined)[] = new Array(nx * ny);
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const x0 = Math.min(tris[b], tris[b + 3], tris[b + 6]);
    const x1 = Math.max(tris[b], tris[b + 3], tris[b + 6]);
    const y0 = Math.min(tris[b + 1], tris[b + 4], tris[b + 7]);
    const y1 = Math.max(tris[b + 1], tris[b + 4], tris[b + 7]);
    for (let gy = Math.floor((y0 - minY) / cell); gy <= Math.floor((y1 - minY) / cell); gy++)
      for (let gx = Math.floor((x0 - minX) / cell); gx <= Math.floor((x1 - minX) / cell); gx++)
        (cells[gy * nx + gx] ??= []).push(t);
  }
  return { tris, minX, minY, cell, nx, ny, cells };
}

/** bbox와 겹칠 수 있는 삼각형 번호 */
function trisIn(s: DrapeSurface, x0: number, y0: number, x1: number, y1: number): Set<number> {
  const out = new Set<number>();
  const gx0 = Math.max(0, Math.floor((x0 - s.minX) / s.cell));
  const gx1 = Math.min(s.nx - 1, Math.floor((x1 - s.minX) / s.cell));
  const gy0 = Math.max(0, Math.floor((y0 - s.minY) / s.cell));
  const gy1 = Math.min(s.ny - 1, Math.floor((y1 - s.minY) / s.cell));
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++) for (const t of s.cells[gy * s.nx + gx] ?? []) out.add(t);
  return out;
}

/** 볼록 다각형(삼각형) 반평면으로 자르기 — 대상 다각형은 오목해도 된다 */
function clipByEdge(poly: Point2[], ax: number, ay: number, bx: number, by: number, sign: number): Point2[] {
  const out: Point2[] = [];
  const side = (p: Point2) => sign * ((bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax));
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

function area2(p: Point2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a;
}

/**
 * 다각형을 지형에 얹은 삼각형 위치 배열(three 좌표 x, y=고도+lift, z=-y).
 * 지형 범위 밖 부분은 버린다.
 */
export function drapePolygon(s: DrapeSurface, poly: Point2[], lift: number, out: number[] = []): number[] {
  if (poly.length < 3) return out;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const T = s.tris;
  for (const t of trisIn(s, x0, y0, x1, y1)) {
    const b = t * 9;
    const ax = T[b], ay = T[b + 1], az = T[b + 2];
    const bx = T[b + 3], by = T[b + 4], bz = T[b + 5];
    const cx = T[b + 6], cy = T[b + 7], cz = T[b + 8];
    const tx0 = Math.min(ax, bx, cx), tx1 = Math.max(ax, bx, cx);
    const ty0 = Math.min(ay, by, cy), ty1 = Math.max(ay, by, cy);
    if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1) continue;
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(d) < 1e-12) continue;
    const sg = d > 0 ? 1 : -1;
    let c = clipByEdge(poly, ax, ay, bx, by, sg);
    if (c.length >= 3) c = clipByEdge(c, bx, by, cx, cy, sg);
    if (c.length >= 3) c = clipByEdge(c, cx, cy, ax, ay, sg);
    if (c.length < 3 || Math.abs(area2(c)) < 1e-6) continue;
    // 삼각형 평면 z = 무게중심 좌표 보간
    const zAt = (p: Point2) => {
      const w1 = ((p.x - ax) * (cy - ay) - (p.y - ay) * (cx - ax)) / d;
      const w2 = ((bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax)) / d;
      return az + (bz - az) * w1 + (cz - az) * w2;
    };
    const idx = THREE.ShapeUtils.triangulateShape(
      c.map((p) => new THREE.Vector2(p.x, p.y)),
      [],
    );
    for (const [i, j, k] of idx) {
      for (const v of [c[i], c[j], c[k]]) out.push(v.x, zAt(v) + lift, -v.y);
    }
  }
  return out;
}

/** 위치 배열 → 메시 (지형에 붙는 평면 — 법선은 위로) */
export function drapedMesh(
  positions: number[],
  material: THREE.Material,
  colors?: number[],
): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  return new THREE.Mesh(geom, material);
}
