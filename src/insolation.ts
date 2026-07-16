import * as THREE from "three";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { pilotiHeight, worldFootprint } from "./buildings";
import { buildingHeight, type Building, type Point2 } from "./types";
import { edgeHasWindow } from "./windows";

/**
 * PV(M4/M5) 분석 격자·차폐 매스 공용 인프라.
 * ⚠️ 예전에는 이 파일이 M2(정북일조) 레이캐스팅 시뮬레이션까지 담당했지만,
 * 정북일조는 실제로는 일조 시뮬레이션이 아니라 정북사선 거리 제한 검토였음이 밝혀져
 * northsetback.ts(순수 기하 계산)로 완전히 대체됐다. 이 파일은 이제 PV 잠재량
 * 분석(pv.ts/pvenergy.ts)이 공유하는 격자 생성·레이캐스팅 차폐 매스만 담당한다.
 */

// three-mesh-bvh 가속 레이캐스트 활성화 (모듈 로드 시 1회)
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** 자기 면과의 교차를 피하는 레이 시작점 오프셋 (m) */
export const RAY_EPS = 0.05;
export const RAY_FAR = 5000;

export interface GridCell {
  buildingId: string;
  surface: "wall" | "roof";
  /** 셀 중심 (three 월드 좌표) */
  center: THREE.Vector3;
  /** 바깥쪽 법선 (three 월드 좌표, 단위벡터) */
  normal: THREE.Vector3;
  /** 오버레이 표시용 셀 크기 (가로, 세로 m) */
  w: number;
  h: number;
}

// ---------- 격자 생성 ----------

function signedArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInPolygon(x: number, y: number, pts: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i];
    const pj = pts[j];
    if (
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 분석 대상 건물의 벽면·지붕을 gridSize 간격 격자로 분할.
 * @param excludeWindowWalls true면 PLAN_WIN이 매칭된(창이 있는) 벽면 에지를 제외한다
 *   (M4/M5 PV: 유리면에는 패널을 설치하지 않으므로). windowSegments가 비어있는(창
 *   데이터 미지정) 건물은 하위호환으로 모든 벽을 그대로 포함한다.
 * @param northAngleDeg 도면 Y+ 기준 정북 보정(반시계, 도) — 현재는 방위 라벨링에만 쓰인다
 * @param isTarget 분석 대상 여부 판별. 기본값은 PV(M4/M5)용 `b.analysisTarget`(계획주동).
 *   일조권 검토(sunhours.ts)처럼 다른 건물군(인접건물)을 대상으로 하려면 별도 predicate를 넘긴다.
 */
export function buildAnalysisGrid(
  buildings: Building[],
  gridSize: number,
  northAngleDeg: number,
  excludeWindowWalls = false,
  isTarget: (b: Building) => boolean = (b) => b.analysisTarget,
): GridCell[] {
  const cells: GridCell[] = [];
  void northAngleDeg; // 방위 라벨은 pv.ts의 faceLabel()에서 별도 계산 — 여기선 필터링에 안 씀

  for (const b of buildings) {
    if (!isTarget(b)) continue;
    const fp = worldFootprint(b);
    const H = buildingHeight(b);
    if (H <= 0 || fp.length < 3) continue;
    const windingSign = signedArea(fp) >= 0 ? 1 : -1;

    for (let i = 0; i < fp.length; i++) {
      const p1 = fp[i];
      const p2 = fp[(i + 1) % fp.length];
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      if (
        excludeWindowWalls &&
        b.windowSegments.length > 0 &&
        edgeHasWindow(b.footprint[i], b.footprint[(i + 1) % b.footprint.length], b.windowSegments)
      ) {
        continue; // 창 있는 벽 — PV 설치 대상 제외
      }
      // CCW(양의 면적) 폴리곤에서 에지 진행방향의 오른쪽이 바깥
      const nx = (windingSign * ey) / len;
      const ny = (-windingSign * ex) / len;

      const ncol = Math.max(1, Math.round(len / gridSize));
      const nrow = Math.max(1, Math.round(H / gridSize));
      const normal = new THREE.Vector3(nx, 0, -ny);
      for (let ci = 0; ci < ncol; ci++) {
        const t = (ci + 0.5) / ncol;
        const px = p1.x + ex * t;
        const py = p1.y + ey * t;
        for (let ri = 0; ri < nrow; ri++) {
          const z = ((ri + 0.5) / nrow) * H;
          cells.push({
            buildingId: b.id,
            surface: "wall",
            center: new THREE.Vector3(px, z, -py),
            normal: normal.clone(),
            w: len / ncol,
            h: H / nrow,
          });
        }
      }
    }

    // 지붕: 바운딩 박스를 격자로 훑고 중심점이 폴리곤 안이면 셀 채택 (항상 포함 — 창 개념 없음)
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of fp) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const up = new THREE.Vector3(0, 1, 0);
    for (let x = minX + gridSize / 2; x < maxX; x += gridSize) {
      for (let y = minY + gridSize / 2; y < maxY; y += gridSize) {
        if (!pointInPolygon(x, y, fp)) continue;
        cells.push({
          buildingId: b.id,
          surface: "roof",
          center: new THREE.Vector3(x, H, -y),
          normal: up.clone(),
          w: gridSize,
          h: gridSize,
        });
      }
    }
  }
  return cells;
}

// ---------- 차폐 매스 (BVH) ----------

/**
 * 전 건물의 차폐 매스 생성 (월드 좌표, BVH 포함).
 * 필로티 층수만큼 하부는 비워서 레이가 통과한다.
 */
export function buildObstructionMeshes(buildings: Building[]): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const b of buildings) {
    const H = buildingHeight(b);
    const base = Math.min(pilotiHeight(b), H);
    if (H - base < 0.01) continue;
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;

    const shape = new THREE.Shape();
    fp.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, p.y);
      else shape.lineTo(p.x, p.y);
    });
    shape.closePath();

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: H - base,
      bevelEnabled: false,
    });
    if (base > 0) geom.translate(0, 0, base);
    geom.rotateX(-Math.PI / 2); // DXF y+ → three -z
    (geom as any).computeBoundsTree();
    meshes.push(new THREE.Mesh(geom));
  }
  return meshes;
}

export function disposeObstructionMeshes(meshes: THREE.Mesh[]): void {
  for (const m of meshes) {
    (m.geometry as any).disposeBoundsTree();
    m.geometry.dispose();
  }
}
