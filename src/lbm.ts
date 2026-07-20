import { worldFootprint } from "./buildings";
import { pointInPolygon } from "./geom2d";
import { flowDirection, traceStreamlines, type Streamline, type WindField } from "./wind";
import type { Building, Point2, Site } from "./types";

/**
 * M10 — LBM(격자 볼츠만, D2Q9) 바람 시뮬레이션.
 * M8 포텐셜 근사(wind.ts)를 대체하지 않는 **별도 정밀 모드** — M8은 즉시 계산되는
 * 개략 검토, M10은 수백~수천 스텝을 돌려 수렴시키는 2D 유동 시뮬레이션이다.
 * 두 모드를 합치거나 한쪽을 지우지 말 것.
 *
 * 좌표 규약:
 * - 시뮬레이션은 **흐름 정렬 로컬 좌표**에서 돈다 — 흐름이 항상 +x. 유입(좌) Zou-He
 *   속도 경계, 유출(우) zero-gradient, 상·하 슬립(경면 반사), 건물 bounce-back(노슬립).
 * - 로컬 → DXF 변환은 angle(흐름 진행 방향의 DXF 각도)만큼 회전. 풍향(windDirDeg)은
 *   M8과 동일하게 **바람이 불어오는 방향**(0=북, 90=동 — EPW 규약)이고 northAngle
 *   보정도 flowDirection()을 그대로 재사용한다.
 * - 결과 속도는 전부 **주풍속 대비 비율(U/U₀)** — 물리 m/s는 표시 단계에서 곱한다.
 */

// ---------- D2Q9 상수 ----------

/** 격자 속도 벡터 — 0=정지, 1~4=축방향, 5~8=대각 */
const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;
/** 반대 방향 (bounce-back용) */
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;
/** y성분 반전 (상·하 슬립 경면 반사용) */
const MIRROR_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5] as const;

/** 유입 격자 속도 (lattice units) — Ma≈0.17, 비압축성 근사 유효 범위 */
export const LBM_U_LAT = 0.1;
/**
 * BGK 완화 시간 — ν=(τ-0.5)/3=0.1, 건물 20셀 기준 Re≈20.
 * τ=0.6(Re≈60)은 와류 방출 경계라 잔차가 0.5%대에서 정체(미수렴) — 배치 검토가
 * 원하는 것은 정상(steady) 유동 패턴이므로 점성을 키워 확실히 수렴시킨다.
 */
export const LBM_TAU = 0.8;
/** 수렴 판단 — 연속 LBM_CONV_STREAK 스텝 동안 최대 속도 변화율 < LBM_CONV_TOL */
export const LBM_CONV_TOL = 0.001;
export const LBM_CONV_STREAK = 10;
/** 발산 방지 상한 스텝 */
export const LBM_MAX_STEPS = 6000;
/** 바람 그늘 판정 — U < 0.5×U₀ (M8의 0.3과 다른 기준임을 UI에 명시) */
export const LBM_SHADOW_RATIO = 0.5;
/** 자동 격자 선택 시 셀 수 상한 — JS 단일 스레드에서 수천 스텝을 감당하는 규모 */
export const LBM_AUTO_MAX_CELLS = 40_000;
/** 격자 해상도 선택지 (m) */
export const LBM_GRID_OPTIONS = [2, 4, 8] as const;

// ---------- 도메인 (흐름 정렬 격자) ----------

export interface LbmDomain {
  nx: number;
  ny: number;
  gridM: number;
  /** 셀 (0,0) 중심의 로컬 좌표 (흐름 정렬 — 흐름은 항상 +x) */
  lx0: number;
  ly0: number;
  /** 로컬 → DXF 회전각 (rad) — 흐름 진행 방향의 DXF 각도 */
  angle: number;
  /** 1=건물 내부 (row-major iy*nx+ix) */
  solid: Uint8Array;
  fluidCells: number;
}

/** 로컬 좌표 → DXF */
export function lbmLocalToDxf(domain: LbmDomain, lx: number, ly: number): Point2 {
  const c = Math.cos(domain.angle);
  const s = Math.sin(domain.angle);
  return { x: c * lx - s * ly, y: s * lx + c * ly };
}

/** DXF → 로컬 좌표 */
export function lbmDxfToLocal(domain: LbmDomain, x: number, y: number): Point2 {
  const c = Math.cos(domain.angle);
  const s = Math.sin(domain.angle);
  return { x: c * x + s * y, y: -s * x + c * y };
}

interface FlowExtent {
  angle: number;
  /** 회전(흐름 정렬)된 footprint들 */
  footprints: Point2[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** footprint를 흐름 정렬 좌표로 회전하고 여유(업풍<다운스트림) 포함 범위를 계산 */
function computeFlowExtent(
  buildings: Building[],
  site: Site,
  windDirDeg: number,
): FlowExtent {
  const flow = flowDirection(windDirDeg, site.northAngle);
  const angle = Math.atan2(flow.y, flow.x);
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  const footprints: Point2[][] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of buildings) {
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    const rot = fp.map((p) => ({ x: c * p.x + s * p.y, y: -s * p.x + c * p.y }));
    footprints.push(rot);
    for (const p of rot) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (footprints.length === 0) {
    minX = -30;
    minY = -30;
    maxX = 30;
    maxY = 30;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  // 업풍은 짧게, 다운스트림은 후류가 담기도록 길게. 측면은 슬립 벽이라 좁으면
  // 블로키지(채널 가속)로 전역 속도가 부풀어 오른다 — 0.75×span으로 여유를 둔다
  const upstream = Math.max(20, 0.5 * span);
  const downstream = Math.max(30, 1.0 * span);
  const lateral = Math.max(25, 0.75 * span);
  return {
    angle,
    footprints,
    minX: minX - upstream,
    minY: minY - lateral,
    maxX: maxX + downstream,
    maxY: maxY + lateral,
  };
}

function extentCells(ext: FlowExtent, gridM: number): { nx: number; ny: number } {
  return {
    nx: Math.max(4, Math.ceil((ext.maxX - ext.minX) / gridM) + 1),
    ny: Math.max(4, Math.ceil((ext.maxY - ext.minY) / gridM) + 1),
  };
}

/**
 * 격자 해상도 자동 선택 — 기본 2m에서 시작해 셀 수가 LBM_AUTO_MAX_CELLS를 넘으면
 * 1m씩 키운다(대지가 크면 3~4m로 조정, 최대 8m).
 */
export function chooseLbmGridM(
  buildings: Building[],
  site: Site,
  windDirDeg: number,
): number {
  const ext = computeFlowExtent(buildings, site, windDirDeg);
  for (let g = 2; g < 8; g++) {
    const { nx, ny } = extentCells(ext, g);
    if (nx * ny <= LBM_AUTO_MAX_CELLS) return g;
  }
  return 8;
}

/** 흐름 정렬 LBM 도메인 생성 — 건물 footprint를 solid 마스크로 래스터라이즈 */
export function buildLbmDomain(
  buildings: Building[],
  site: Site,
  windDirDeg: number,
  gridM: number,
): LbmDomain {
  const ext = computeFlowExtent(buildings, site, windDirDeg);
  const { nx, ny } = extentCells(ext, gridM);
  const solid = new Uint8Array(nx * ny);
  let fluidCells = nx * ny;
  for (let iy = 0; iy < ny; iy++) {
    const ly = ext.minY + iy * gridM;
    for (let ix = 0; ix < nx; ix++) {
      const lx = ext.minX + ix * gridM;
      for (const fp of ext.footprints) {
        if (pointInPolygon(lx, ly, fp)) {
          solid[iy * nx + ix] = 1;
          fluidCells--;
          break;
        }
      }
    }
  }
  return { nx, ny, gridM, lx0: ext.minX, ly0: ext.minY, angle: ext.angle, solid, fluidCells };
}

// ---------- D2Q9 솔버 ----------

/**
 * BGK 충돌 + 스트리밍 + 경계조건을 한 스텝으로 묶은 솔버.
 * step()이 반환하는 값 = 이번 스텝 최대 속도 변화율(유입속도 대비) — 수렴 판단용.
 */
export class LbmSolver {
  readonly domain: LbmDomain;
  /** 분포함수 (cell-major: (iy*nx+ix)*9 + dir) */
  private f: Float32Array;
  private fTmp: Float32Array;
  /** 로컬(흐름 정렬) 속도 성분 (lattice units) */
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  private speed: Float32Array;
  private prevSpeed: Float32Array;
  steps = 0;

  constructor(domain: LbmDomain) {
    this.domain = domain;
    const n = domain.nx * domain.ny;
    this.f = new Float32Array(n * 9);
    this.fTmp = new Float32Array(n * 9);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.prevSpeed = new Float32Array(n);
    // 초기화: 전 유체 셀을 유입 평형분포(ρ=1, u=(U_LAT,0))로
    for (let i = 0; i < n; i++) {
      if (domain.solid[i]) continue;
      this.setEquilibrium(this.f, i, 1, LBM_U_LAT, 0);
      this.ux[i] = LBM_U_LAT;
      this.speed[i] = LBM_U_LAT;
      this.prevSpeed[i] = LBM_U_LAT;
    }
  }

  private setEquilibrium(
    arr: Float32Array,
    cell: number,
    rho: number,
    ux: number,
    uy: number,
  ): void {
    const usq = 1.5 * (ux * ux + uy * uy);
    for (let d = 0; d < 9; d++) {
      const cu = 3 * (CX[d] * ux + CY[d] * uy);
      arr[cell * 9 + d] = W[d] * rho * (1 + cu + 0.5 * cu * cu - usq);
    }
  }

  /** 1 스텝 진행. 반환값: 최대 |Δ속도| / U_LAT */
  step(): number {
    const { nx, ny, solid } = this.domain;
    const f = this.f;
    const fT = this.fTmp;
    const invTau = 1 / LBM_TAU;
    // 스트리밍이 닿지 않는 슬롯(벽 인접 모서리 등)이 이전 값을 유지하도록 복사로 시작
    fT.set(f);

    // 충돌 + 스트리밍 (fused). 벽(solid) 이웃은 같은 셀 반대방향으로 bounce-back,
    // 상·하 이탈은 y성분만 뒤집는 경면 반사(슬립), 좌·우 이탈은 버림(경계조건이 채움)
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cell = iy * nx + ix;
        if (solid[cell]) continue;
        const base = cell * 9;
        let rho = 0;
        let mx = 0;
        let my = 0;
        for (let d = 0; d < 9; d++) {
          const v = f[base + d];
          rho += v;
          mx += CX[d] * v;
          my += CY[d] * v;
        }
        const ux = mx / rho;
        const uy = my / rho;
        const usq = 1.5 * (ux * ux + uy * uy);
        for (let d = 0; d < 9; d++) {
          const cu = 3 * (CX[d] * ux + CY[d] * uy);
          const feq = W[d] * rho * (1 + cu + 0.5 * cu * cu - usq);
          const post = f[base + d] - (f[base + d] - feq) * invTau;
          let tx = ix + CX[d];
          let ty = iy + CY[d];
          let dir = d;
          if (ty < 0 || ty >= ny) {
            // 상·하 슬립 — 경면 반사 (y성분 반전, 같은 행 유지)
            dir = MIRROR_Y[d];
            ty = iy;
          }
          if (tx < 0 || tx >= nx) continue; // 좌·우 이탈 — BC 패스가 채운다
          const target = ty * nx + tx;
          if (solid[target]) {
            fT[base + OPP[dir]] = post; // 노슬립 bounce-back
          } else {
            fT[target * 9 + dir] = post;
          }
        }
      }
    }

    // 유입 (ix=0) — Zou-He 속도 경계: u=(U_LAT, 0)
    const u0 = LBM_U_LAT;
    for (let iy = 0; iy < ny; iy++) {
      const cell = iy * nx;
      if (solid[cell]) continue;
      const b = cell * 9;
      const rho =
        (fT[b] + fT[b + 2] + fT[b + 4] + 2 * (fT[b + 3] + fT[b + 6] + fT[b + 7])) /
        (1 - u0);
      fT[b + 1] = fT[b + 3] + (2 / 3) * rho * u0;
      fT[b + 5] = fT[b + 7] - 0.5 * (fT[b + 2] - fT[b + 4]) + (1 / 6) * rho * u0;
      fT[b + 8] = fT[b + 6] + 0.5 * (fT[b + 2] - fT[b + 4]) + (1 / 6) * rho * u0;
    }

    // 유출 (ix=nx-1) — zero-gradient: 좌측 이웃의 유입 방향 분포 복사
    for (let iy = 0; iy < ny; iy++) {
      const cell = iy * nx + (nx - 1);
      if (solid[cell]) continue;
      const b = cell * 9;
      const src = (cell - 1) * 9;
      fT[b + 3] = fT[src + 3];
      fT[b + 6] = fT[src + 6];
      fT[b + 7] = fT[src + 7];
    }

    // swap + 매크로 변수 갱신 + 수렴 잔차
    this.f = fT;
    this.fTmp = f;
    let maxDelta = 0;
    const n = nx * ny;
    for (let i = 0; i < n; i++) {
      if (solid[i]) continue;
      const base = i * 9;
      let rho = 0;
      let mx = 0;
      let my = 0;
      for (let d = 0; d < 9; d++) {
        const v = this.f[base + d];
        rho += v;
        mx += CX[d] * v;
        my += CY[d] * v;
      }
      const ux = mx / rho;
      const uy = my / rho;
      this.ux[i] = ux;
      this.uy[i] = uy;
      const sp = Math.hypot(ux, uy);
      this.speed[i] = sp;
      const delta = Math.abs(sp - this.prevSpeed[i]);
      if (delta > maxDelta) maxDelta = delta;
    }
    const t = this.prevSpeed;
    this.prevSpeed = this.speed;
    this.speed = t;
    this.steps++;
    return maxDelta / LBM_U_LAT;
  }

  /** 속도비 U/U₀ 배열 (새 배열 — transferable로 넘겨도 안전) */
  speedRatio(): Float32Array {
    const n = this.domain.nx * this.domain.ny;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.hypot(this.ux[i], this.uy[i]) / LBM_U_LAT;
    }
    return out;
  }
}

/** 동기 실행 (테스트·워커 공용) — 수렴(연속 10스텝 잔차<0.1%) 또는 maxSteps에서 정지 */
export function runLbmSync(
  domain: LbmDomain,
  maxSteps: number = LBM_MAX_STEPS,
  onProgress?: (step: number, residual: number) => void,
  progressEvery = 50,
): { solver: LbmSolver; steps: number; converged: boolean } {
  const solver = new LbmSolver(domain);
  let streak = 0;
  for (let s = 1; s <= maxSteps; s++) {
    const residual = solver.step();
    streak = residual < LBM_CONV_TOL ? streak + 1 : 0;
    if (onProgress && s % progressEvery === 0) onProgress(s, residual);
    if (streak >= LBM_CONV_STREAK) {
      return { solver, steps: s, converged: true };
    }
  }
  return { solver, steps: maxSteps, converged: false };
}

// ---------- 결과 지표 ----------

export interface LbmMetrics {
  /** 유체 셀 최대 속도비 U/U₀ — 협곡효과 지표 */
  maxRatio: number;
  /** U < 0.5×U₀ 유체 셀 면적 (㎡) — 바람 그늘 */
  shadowAreaM2: number;
  /** 유체 셀 평균 속도비 */
  meanRatio: number;
}

export function computeLbmMetrics(domain: LbmDomain, ratio: Float32Array): LbmMetrics {
  const { nx, ny, solid, gridM } = domain;
  let maxRatio = 0;
  let sum = 0;
  let fluid = 0;
  let shadowCells = 0;
  for (let i = 0; i < nx * ny; i++) {
    if (solid[i]) continue;
    const r = ratio[i];
    fluid++;
    sum += r;
    if (r > maxRatio) maxRatio = r;
    if (r < LBM_SHADOW_RATIO) shadowCells++;
  }
  return {
    maxRatio,
    shadowAreaM2: shadowCells * gridM * gridM,
    meanRatio: fluid > 0 ? sum / fluid : 0,
  };
}

// ---------- M8 스트림라인 인프라 재사용을 위한 WindField 변환 ----------

/**
 * LBM 속도장(흐름 정렬 로컬)을 DXF 축 정렬 WindField로 재샘플링 —
 * M8 traceStreamlines/createWindOverlay를 그대로 재사용하기 위한 어댑터.
 * 속도는 U/U₀ 비율로 정규화(windSpeedMs=1) — M8과 같은 색 규약을 쓴다.
 * 회전 도메인 밖 모서리는 자유류(비율 1)로 채워 시드가 도메인까지 도달하게 한다.
 */
export function lbmToWindField(
  domain: LbmDomain,
  ux: Float32Array,
  uy: Float32Array,
  buildings: Building[],
): WindField {
  const { nx, ny, gridM, lx0, ly0, angle } = domain;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // 회전 도메인 네 모서리의 DXF bbox
  const cornersL: Point2[] = [
    { x: lx0, y: ly0 },
    { x: lx0 + (nx - 1) * gridM, y: ly0 },
    { x: lx0 + (nx - 1) * gridM, y: ly0 + (ny - 1) * gridM },
    { x: lx0, y: ly0 + (ny - 1) * gridM },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of cornersL) {
    const d = lbmLocalToDxf(domain, p.x, p.y);
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x);
    maxY = Math.max(maxY, d.y);
  }
  const gnx = Math.max(2, Math.ceil((maxX - minX) / gridM) + 1);
  const gny = Math.max(2, Math.ceil((maxY - minY) / gridM) + 1);
  maxX = minX + (gnx - 1) * gridM;
  maxY = minY + (gny - 1) * gridM;

  const footprints = buildings
    .map((b) => worldFootprint(b))
    .filter((fp) => fp.length >= 3);
  const u = new Float32Array(gnx * gny);
  const v = new Float32Array(gnx * gny);
  const blocked = new Uint8Array(gnx * gny);
  // 자유류(로컬 +x, 비율 1)의 DXF 성분 — 도메인 밖 모서리 채움용
  const freeU = c;
  const freeV = s;
  let shadowCells = 0;

  for (let iy = 0; iy < gny; iy++) {
    const y = minY + iy * gridM;
    for (let ix = 0; ix < gnx; ix++) {
      const x = minX + ix * gridM;
      const idx = iy * gnx + ix;
      let inside = false;
      for (const fp of footprints) {
        if (pointInPolygon(x, y, fp)) {
          inside = true;
          break;
        }
      }
      if (inside) {
        blocked[idx] = 1;
        continue;
      }
      const loc = lbmDxfToLocal(domain, x, y);
      const fx = (loc.x - lx0) / gridM;
      const fy = (loc.y - ly0) / gridM;
      if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) {
        u[idx] = freeU;
        v[idx] = freeV;
        continue;
      }
      const ix0 = Math.min(nx - 2, Math.floor(fx));
      const iy0 = Math.min(ny - 2, Math.floor(fy));
      const tx = fx - ix0;
      const ty = fy - iy0;
      const i00 = iy0 * nx + ix0;
      const i10 = i00 + 1;
      const i01 = i00 + nx;
      const i11 = i01 + 1;
      const lerp2 = (a: Float32Array) =>
        (a[i00] * (1 - tx) + a[i10] * tx) * (1 - ty) +
        (a[i01] * (1 - tx) + a[i11] * tx) * ty;
      // 로컬 속도 → 비율 정규화 → DXF 성분으로 회전
      const lu = lerp2(ux) / LBM_U_LAT;
      const lv = lerp2(uy) / LBM_U_LAT;
      u[idx] = c * lu - s * lv;
      v[idx] = s * lu + c * lv;
      if (Math.hypot(u[idx], v[idx]) < LBM_SHADOW_RATIO) shadowCells++;
    }
  }

  return {
    originX: minX,
    originY: minY,
    gridM,
    nx: gnx,
    ny: gny,
    u,
    v,
    blocked,
    windSpeedMs: 1, // 비율 정규화 — speedRatio가 곧 U/U₀
    flowDir: { x: freeU, y: freeV },
    bounds: { minX, minY, maxX, maxY },
    shadowAreaM2: shadowCells * gridM * gridM,
  };
}

// ---------- 결과 타입 ----------

export interface LbmResult {
  /** 풍향 (도, 0=북 — 불어오는 방향, EPW 규약) */
  windDirDeg: number;
  /** "auto"면 EPW 주풍향에서 가져온 것 */
  windDirSource: "epw" | "manual";
  /** 유입 풍속 (m/s) */
  windSpeedMs: number;
  gridM: number;
  steps: number;
  converged: boolean;
  domain: LbmDomain;
  /** 속도비 U/U₀ (row-major iy*nx+ix, 건물 셀 0) */
  ratio: Float32Array;
  maxRatio: number;
  shadowAreaM2: number;
  streamlines: Streamline[];
}

/** 워커 완료 후 결과 조립 — 지표·스트림라인까지 한 번에 */
export function assembleLbmResult(
  domain: LbmDomain,
  ux: Float32Array,
  uy: Float32Array,
  buildings: Building[],
  params: {
    windDirDeg: number;
    windDirSource: "epw" | "manual";
    windSpeedMs: number;
    steps: number;
    converged: boolean;
  },
  seedCount = 24,
): LbmResult {
  const n = domain.nx * domain.ny;
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ratio[i] = Math.hypot(ux[i], uy[i]) / LBM_U_LAT;
  }
  const metrics = computeLbmMetrics(domain, ratio);
  const field = lbmToWindField(domain, ux, uy, buildings);
  const streamlines = traceStreamlines(field, seedCount);
  return {
    windDirDeg: params.windDirDeg,
    windDirSource: params.windDirSource,
    windSpeedMs: params.windSpeedMs,
    gridM: domain.gridM,
    steps: params.steps,
    converged: params.converged,
    domain,
    ratio,
    maxRatio: metrics.maxRatio,
    shadowAreaM2: metrics.shadowAreaM2,
    streamlines,
  };
}
