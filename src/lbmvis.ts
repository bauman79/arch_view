import * as THREE from "three";
import { lbmLocalToDxf, type LbmDomain } from "./lbm";

/**
 * M10 — LBM 속도 히트맵 시각화.
 * 도메인 셀 수 크기의 캔버스에 속도비를 픽셀로 찍고 CanvasTexture로 지면 위
 * PlaneGeometry에 얹는다 (ShaderMaterial 없이 단순하게). 시뮬레이션이 흐름 정렬
 * 좌표에서 돌므로 평면을 domain.angle만큼 Y축 회전해 DXF 배치에 맞춘다.
 * 스트림라인(WIND_OVERLAY_Y=0.3)보다 낮게 깔아 함께 켜도 겹쳐 보인다.
 */

const LBM_HEATMAP_Y = 0.2;
const LBM_HEATMAP_OPACITY = 0.78;

/** 색 구간점 — U/U₀ 비율 0~2 정규화: 저속 파랑 → 청록 → 노랑 → 초고속 빨강 */
const RATIO_STOPS: [number, [number, number, number]][] = [
  [0.0, [0x1e, 0x3a, 0x8a]], // 짙은 파랑 (정체)
  [0.5, [0x06, 0xb6, 0xd4]], // 청록 (감속)
  [1.2, [0xea, 0xb3, 0x08]], // 노랑 (주풍속 부근~가속)
  [2.0, [0xef, 0x44, 0x44]], // 빨강 (초고속 — 2배 이상 포화)
];

/** 속도비 → RGB (0~255). 2.0 이상은 빨강으로 포화 */
export function lbmColor(ratio: number): [number, number, number] {
  if (ratio <= RATIO_STOPS[0][0]) return [...RATIO_STOPS[0][1]];
  for (let i = 1; i < RATIO_STOPS.length; i++) {
    const [r1, c1] = RATIO_STOPS[i];
    if (ratio <= r1) {
      const [r0, c0] = RATIO_STOPS[i - 1];
      const t = (ratio - r0) / (r1 - r0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return [...RATIO_STOPS[RATIO_STOPS.length - 1][1]];
}

export interface LbmHeatmap {
  mesh: THREE.Mesh;
  /** 속도비 배열(row-major iy*nx+ix)로 텍스처 갱신 — 진행 중 실시간 호출 가능 */
  update(ratio: Float32Array): void;
  dispose(): void;
}

/** 지형 드레이프 시 정점을 지형 위로 띄우는 여유 (m) — 경사면 관통 방지 */
const DRAPE_LIFT = 0.4;
/** 드레이프 세그먼트 상한 (축당) — 대형 격자에서 정점 폭주 방지 */
const DRAPE_MAX_SEG = 200;

/**
 * 히트맵 평면 생성 — scene 추가는 호출자 몫.
 * 캔버스는 셀당 1픽셀, LinearFilter 보간으로 부드럽게 표시. 건물(solid) 셀은 투명.
 * @param sampleZ (x,y DXF 좌표)→지형 고도(m). 주면 평면 정점을 지형 표면에 드레이프해
 *   지형 모드에서도 히트맵이 묻히지 않는다 (시뮬레이션 자체는 2D — 표시만 따라감).
 */
export function createLbmHeatmap(
  domain: LbmDomain,
  sampleZ?: (x: number, y: number) => number,
): LbmHeatmap {
  const { nx, ny, gridM, lx0, ly0, angle, solid } = domain;
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(nx, ny);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  // 드레이프 시에만 세그먼트 분할 (평지는 정점 4개면 충분)
  const segX = sampleZ ? Math.min(nx - 1, DRAPE_MAX_SEG) : 1;
  const segY = sampleZ ? Math.min(ny - 1, DRAPE_MAX_SEG) : 1;
  const geom = new THREE.PlaneGeometry(nx * gridM, ny * gridM, segX, segY);
  geom.rotateX(-Math.PI / 2); // 지면에 눕힘 — 로컬 +x→+x, +y→-z(=DXF +y)
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: LBM_HEATMAP_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    // 대지 회색 채움(site-fill)이 polygonOffset -4로 깊이를 당겨 히트맵을 가리므로
    // 그보다 더 당긴다 — depthWrite=false라 다른 물체를 가리는 부작용은 없다
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "lbm-heatmap";
  // 도메인 중심(로컬) → DXF → three(x, y, -z)
  const centerLx = lx0 + ((nx - 1) * gridM) / 2;
  const centerLy = ly0 + ((ny - 1) * gridM) / 2;
  const center = lbmLocalToDxf(domain, centerLx, centerLy);
  mesh.rotation.y = angle; // 로컬 → DXF 회전 (DXF 반시계 = three +Y 회전)

  if (sampleZ) {
    // 정점을 지형 고도로 변위 — rotateX 후 평면 로컬 (vx, 0, vz)에서 vz = -플레인y이므로
    // 로컬 격자 좌표는 (centerLx+vx, centerLy-vz). y성분은 mesh.rotation.y에 불변이라
    // 절대 고도를 정점에 직접 넣고 mesh.position.y는 0으로 둔다.
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const p = lbmLocalToDxf(domain, centerLx + pos.getX(i), centerLy - pos.getZ(i));
      pos.setY(i, sampleZ(p.x, p.y) + DRAPE_LIFT);
    }
    pos.needsUpdate = true;
    mesh.position.set(center.x, 0, -center.y);
  } else {
    mesh.position.set(center.x, LBM_HEATMAP_Y, -center.y);
  }

  function update(ratio: Float32Array): void {
    const data = image.data;
    for (let iy = 0; iy < ny; iy++) {
      // flipY(기본 true): 캔버스 윗줄이 평면의 +y(로컬 ly 최대) — 행을 뒤집어 찍는다
      const row = ny - 1 - iy;
      for (let ix = 0; ix < nx; ix++) {
        const cell = iy * nx + ix;
        const px = (row * nx + ix) * 4;
        if (solid[cell]) {
          data[px + 3] = 0; // 건물 — 투명
          continue;
        }
        const [r, g, b] = lbmColor(ratio[cell]);
        data[px] = r;
        data[px + 1] = g;
        data[px + 2] = b;
        data[px + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    texture.needsUpdate = true;
  }

  return {
    mesh,
    update,
    dispose() {
      mesh.removeFromParent();
      geom.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}
