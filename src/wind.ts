import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { EPW_HEADER_LINES } from "./epw";
import { pointInPolygon } from "./geom2d";
import type { Building, Point2, Site } from "./types";

/**
 * M8 — 바람길 분석 (개략 검토).
 * EPW 풍향·풍속 통계(주풍향)를 뽑고, 2D 포텐셜 흐름 근사로 대지 평면의 속도장을
 * 만들어 스트림라인·바람그림자(정체 영역)를 시각화한다.
 * ⚠️ CFD가 아니다 — 건물 주변 흐름의 정성적 경향(우회·가속·후류 정체)만 보여주는
 * 개략 도구이며, 수직 방향 흐름·난류·온도 성층은 범위 밖(UI에 명시).
 *
 * 좌표·방향 규약:
 * - 풍향(windDirDeg)은 기상 관측 규약 = **바람이 불어오는 방향**(0=북, 90=동,
 *   EPW 컬럼 20과 동일). 북풍(0°)은 남쪽으로 흐른다 — 흐름 벡터는 내부에서 변환.
 * - 속도장은 DXF 평면 좌표(x=동, y=북, m). northAngle(도면 Y+ 기준 정북 보정,
 *   반시계)은 sun.ts와 같은 방식으로 흐름 벡터를 도면 좌표계로 회전해 반영한다.
 */

// ---------- EPW 풍향·풍속 통계 (windrose) ----------

/** EPW 데이터 행의 풍향/풍속 컬럼 (0-indexed) — 인천 IWEC 실파일로 검증 */
const COL_MONTH = 1;
const COL_WIND_DIR = 20;
const COL_WIND_SPEED = 21;
/** EPW 결측 표기 — 풍향 999, 풍속 999 */
const WIND_MISSING = 999;
/** 정온(calm) 판정 풍속 (m/s) — 방향 통계에서 제외 */
const CALM_MS = 0.5;

export const WIND_SECTORS = 16;
export const WIND_SECTOR_DEG = 360 / WIND_SECTORS;

const SECTOR_LABELS = [
  "북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동",
  "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서",
] as const;

/** 풍향(도) → 16방위 한글 라벨 */
export function windDirLabel(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / WIND_SECTOR_DEG) % WIND_SECTORS;
  return SECTOR_LABELS[idx];
}

export interface WindRoseStats {
  /** 유효(결측 아님) 관측 시간 수 */
  hours: number;
  /** 정온(풍속 < 0.5 m/s) 시간 수 — 방향 도수에서 제외 */
  calmHours: number;
  /** 평균 풍속 (m/s, 정온 포함) */
  meanSpeedMs: number;
  /** 주풍향 (도, 0=북 — 최빈 16방위 섹터의 중심각) */
  prevailingDirDeg: number;
  /** 16방위 도수 (시간 수, 북=index 0부터 시계방향) */
  sectorHours: number[];
}

export interface WindRoseData {
  annual: WindRoseStats;
  /** 1~12월 = index 0~11 */
  monthly: WindRoseStats[];
}

interface RoseAcc {
  hours: number;
  calm: number;
  speedSum: number;
  sectors: number[];
}

function newAcc(): RoseAcc {
  return { hours: 0, calm: 0, speedSum: 0, sectors: new Array(WIND_SECTORS).fill(0) };
}

function accToStats(a: RoseAcc): WindRoseStats {
  let best = 0;
  for (let i = 1; i < WIND_SECTORS; i++) {
    if (a.sectors[i] > a.sectors[best]) best = i;
  }
  return {
    hours: a.hours,
    calmHours: a.calm,
    meanSpeedMs: a.hours > 0 ? a.speedSum / a.hours : 0,
    prevailingDirDeg: best * WIND_SECTOR_DEG,
    sectorHours: [...a.sectors],
  };
}

/**
 * EPW 텍스트에서 풍향·풍속 통계 추출(연간 + 월별).
 * epw.ts(parseEpw, M5 일사 전용)와 달리 행 수 8,760을 강제하지 않는다 —
 * 통계는 부분 데이터로도 성립하기 때문(테스트 합성 데이터 포함).
 */
export function computeWindRose(epwText: string): WindRoseData {
  const lines = epwText.split(/\r?\n/);
  if (lines.length < EPW_HEADER_LINES + 1 || !lines[0].startsWith("LOCATION")) {
    throw new Error("EPW 형식이 아닙니다 (LOCATION 헤더 없음)");
  }
  const annual = newAcc();
  const monthly = Array.from({ length: 12 }, newAcc);

  for (let i = EPW_HEADER_LINES; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(",");
    if (f.length <= COL_WIND_SPEED) continue;
    const month = parseInt(f[COL_MONTH], 10);
    const dir = parseFloat(f[COL_WIND_DIR]);
    const speed = parseFloat(f[COL_WIND_SPEED]);
    if (!isFinite(speed) || speed < 0 || speed >= WIND_MISSING) continue;
    if (!isFinite(dir) || dir < 0 || dir >= WIND_MISSING) continue;
    const accs = [annual];
    if (month >= 1 && month <= 12) accs.push(monthly[month - 1]);
    const calm = speed < CALM_MS;
    const sector = calm
      ? -1
      : Math.round(((dir % 360) + 360) % 360 / WIND_SECTOR_DEG) % WIND_SECTORS;
    for (const a of accs) {
      a.hours++;
      a.speedSum += speed;
      if (calm) a.calm++;
      else a.sectors[sector]++;
    }
  }
  return { annual: accToStats(annual), monthly: monthly.map(accToStats) };
}

// ---------- 2D 포텐셜 흐름 근사 속도장 ----------

/** 바람그림자 판정 — 주풍속 대비 속도비 이 값 미만이면 정체 영역 */
export const WIND_SHADOW_RATIO = 0.3;

export interface WindField {
  /** 격자 [0,0] 셀 중심의 DXF 좌표 */
  originX: number;
  originY: number;
  gridM: number;
  nx: number;
  ny: number;
  /** 셀별 속도 (m/s, DXF 좌표계 x·y 성분, row-major: iy*nx+ix) */
  u: Float32Array;
  v: Float32Array;
  /** 1=건물 내부(속도 0) */
  blocked: Uint8Array;
  /** 입력 주풍속 (m/s) */
  windSpeedMs: number;
  /** 흐름 진행 방향 단위벡터 (도면 좌표 — 풍향의 반대쪽) */
  flowDir: Point2;
  /** 도메인 경계 (DXF 좌표) */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** 건물 외부 셀 중 속도비 < WIND_SHADOW_RATIO 면적 (㎡) */
  shadowAreaM2: number;
}

interface Obstacle {
  fp: Point2[];
  cx: number;
  cy: number;
  /** 편향(밀어내기) 영향 반경 스케일 (m) */
  influenceR: number;
  /** 흐름 직각방향 반폭 (m) — 후류 폭 */
  halfWidth: number;
  /** 흐름 방향 반깊이 (m) — 후류 시작(배면) 위치 */
  halfDepth: number;
}

function polygonArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

/** 점→폴리곤 외곽 최단거리 (내부 여부는 호출자가 별도 판단) */
function distToPolygonBoundary(x: number, y: number, pts: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 1e-12 ? ((x - a.x) * ex + (y - a.y) * ey) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x - (a.x + ex * t);
    const dy = y - (a.y + ey * t);
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 풍향(불어오는 방향, 도) → 도면 좌표 흐름 진행 방향 단위벡터.
 * 진북 기준 흐름 = (-sin, -cos) — northAngle만큼 반시계 회전해 도면 좌표로.
 */
export function flowDirection(windDirDeg: number, northAngleDeg: number): Point2 {
  const d = THREE.MathUtils.degToRad(windDirDeg);
  const fx = -Math.sin(d);
  const fy = -Math.cos(d);
  const th = THREE.MathUtils.degToRad(northAngleDeg);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  return { x: fx * cos - fy * sin, y: fx * sin + fy * cos };
}

/**
 * 2D 포텐셜 흐름 근사 속도장.
 * - 균일 흐름(주풍속) + 건물별 "밀어내기" 편향: 격자점이 footprint 내부면 속도 0,
 *   외부면 경계 최단거리 r에 반비례해 감쇠하는(1/(1+r/R)²) 바깥 방향 편향을 더한다
 *   → 스트림라인이 건물을 우회하고 측면에서 가속되는 정성적 패턴.
 * - 후류(바람그림자): 배면 하류의 폭 |t|<halfWidth 영역을 거리에 따라 회복되게
 *   감쇠 — 포텐셜 흐름만으로는 후류가 생기지 않아 별도 근사로 추가한다.
 * @param windDirDeg 풍향(불어오는 방향, 0=북·90=동 — EPW 규약)
 */
export function computeWindField(
  buildings: Building[],
  site: Site,
  windDirDeg: number,
  gridM: number,
): WindField {
  const windSpeed = 1; // 정규화 속도장 — 실제 m/s는 표시 단계에서 곱한다
  const flow = flowDirection(windDirDeg, site.northAngle);
  const perp = { x: -flow.y, y: flow.x };

  // 도메인: 전 건물 bbox + 여유
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const obstacles: Obstacle[] = [];
  for (const b of buildings) {
    const fp = worldFootprint(b);
    if (fp.length < 3) continue;
    let cx = 0;
    let cy = 0;
    for (const p of fp) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      cx += p.x;
      cy += p.y;
    }
    cx /= fp.length;
    cy /= fp.length;
    let halfWidth = 0;
    let halfDepth = 0;
    for (const p of fp) {
      halfWidth = Math.max(halfWidth, Math.abs((p.x - cx) * perp.x + (p.y - cy) * perp.y));
      halfDepth = Math.max(halfDepth, Math.abs((p.x - cx) * flow.x + (p.y - cy) * flow.y));
    }
    obstacles.push({
      fp,
      cx,
      cy,
      influenceR: 0.5 * Math.sqrt(polygonArea(fp)) + gridM,
      halfWidth: Math.max(halfWidth, gridM),
      halfDepth,
    });
  }
  if (obstacles.length === 0) {
    minX = -30;
    minY = -30;
    maxX = 30;
    maxY = 30;
  }
  const margin = Math.max(20, 0.4 * Math.max(maxX - minX, maxY - minY));
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  // ceil — 격자가 도메인 전체를 덮어야 경계 진입 스트림라인이 첫 샘플에서 죽지 않는다
  const nx = Math.max(2, Math.ceil((maxX - minX) / gridM) + 1);
  const ny = Math.max(2, Math.ceil((maxY - minY) / gridM) + 1);
  // bounds를 격자 커버리지에 정확히 맞춤 — 시드 배치·이탈 판정과 보간 범위 일치
  maxX = minX + (nx - 1) * gridM;
  maxY = minY + (ny - 1) * gridM;
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  const blocked = new Uint8Array(nx * ny);
  let shadowCells = 0;

  for (let iy = 0; iy < ny; iy++) {
    const y = minY + iy * gridM;
    for (let ix = 0; ix < nx; ix++) {
      const x = minX + ix * gridM;
      const idx = iy * nx + ix;

      let inside = false;
      for (const o of obstacles) {
        if (pointInPolygon(x, y, o.fp)) {
          inside = true;
          break;
        }
      }
      if (inside) {
        blocked[idx] = 1;
        continue; // u=v=0
      }

      let vx = flow.x * windSpeed;
      let vy = flow.y * windSpeed;
      let attenuation = 1;
      for (const o of obstacles) {
        // 밀어내기 편향 — 경계 최단거리 r에 반비례 감쇠
        const r = distToPolygonBoundary(x, y, o.fp);
        const w = 1 / (1 + r / o.influenceR) ** 2;
        if (w > 1e-3) {
          const ax = x - o.cx;
          const ay = y - o.cy;
          const len = Math.hypot(ax, ay);
          if (len > 1e-6) {
            vx += (ax / len) * windSpeed * w;
            vy += (ay / len) * windSpeed * w;
          }
        }
        // 후류(바람그림자) — 배면 하류 폭 안을 거리 회복형으로 감쇠
        const s = (x - o.cx) * flow.x + (y - o.cy) * flow.y;
        const t = (x - o.cx) * perp.x + (y - o.cy) * perp.y;
        if (s > 0 && Math.abs(t) < o.halfWidth) {
          const wakeLen = 6 * o.halfWidth;
          const behind = Math.max(0, s - o.halfDepth);
          if (behind < wakeLen) {
            const lateral = 1 - Math.abs(t) / o.halfWidth;
            const a = 0.95 * lateral * (1 - behind / wakeLen);
            attenuation = Math.min(attenuation, 1 - a);
          }
        }
      }
      vx *= attenuation;
      vy *= attenuation;
      u[idx] = vx;
      v[idx] = vy;
      if (Math.hypot(vx, vy) < WIND_SHADOW_RATIO * windSpeed) shadowCells++;
    }
  }

  return {
    originX: minX,
    originY: minY,
    gridM,
    nx,
    ny,
    u,
    v,
    blocked,
    windSpeedMs: windSpeed,
    flowDir: flow,
    bounds: { minX, minY, maxX, maxY },
    shadowAreaM2: shadowCells * gridM * gridM,
  };
}

/** 속도장 이중선형 보간 샘플. 도메인 밖이면 null */
export function sampleWind(field: WindField, x: number, y: number): Point2 | null {
  const fx = (x - field.originX) / field.gridM;
  const fy = (y - field.originY) / field.gridM;
  if (fx < 0 || fy < 0 || fx > field.nx - 1 || fy > field.ny - 1) return null;
  const ix = Math.min(field.nx - 2, Math.floor(fx));
  const iy = Math.min(field.ny - 2, Math.floor(fy));
  const tx = fx - ix;
  const ty = fy - iy;
  const i00 = iy * field.nx + ix;
  const i10 = i00 + 1;
  const i01 = i00 + field.nx;
  const i11 = i01 + 1;
  const lerp2 = (a: Float32Array) =>
    (a[i00] * (1 - tx) + a[i10] * tx) * (1 - ty) + (a[i01] * (1 - tx) + a[i11] * tx) * ty;
  return { x: lerp2(field.u), y: lerp2(field.v) };
}

/** 격자점 기준 건물 내부 여부 (최근접 셀) */
function isBlockedAt(field: WindField, x: number, y: number): boolean {
  const ix = Math.round((x - field.originX) / field.gridM);
  const iy = Math.round((y - field.originY) / field.gridM);
  if (ix < 0 || iy < 0 || ix >= field.nx || iy >= field.ny) return false;
  return field.blocked[iy * field.nx + ix] === 1;
}

// ---------- 스트림라인 추적 ----------

export interface Streamline {
  points: Point2[];
  /** 경로 평균 속도 / 주풍속 (배율) */
  speedRatio: number;
}

const STREAM_STEP_M = 0.5;
const STREAM_MAX_STEPS = 300;
/** 이 비율 미만으로 느려지면 정체로 보고 중단 */
const STREAM_STALL_RATIO = 0.02;

/**
 * 대지 업풍(바람 불어오는 쪽) 경계에서 seedCount개 시드 → Euler 적분
 * (0.5m 스텝, 최대 300스텝). 건물 내부 진입·도메인 이탈·정체 시 중단.
 */
export function traceStreamlines(field: WindField, seedCount: number): Streamline[] {
  const { bounds, flowDir } = field;
  const perp = { x: -flowDir.y, y: flowDir.x };
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  // 도메인 코너의 perp축 투영 범위 — 시드를 흐름 직각방향으로 고르게 배치
  const corners: Point2[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const c of corners) {
    const t = (c.x - cx) * perp.x + (c.y - cy) * perp.y;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const far = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);

  const lines: Streamline[] = [];
  for (let i = 0; i < seedCount; i++) {
    const t = tMin + ((i + 0.5) / seedCount) * (tMax - tMin);
    // 업풍 먼 곳에서 흐름 방향으로 쏜 반직선의 도메인 진입점 (slab 교차)
    const sx = cx + perp.x * t - flowDir.x * far;
    const sy = cy + perp.y * t - flowDir.y * far;
    let enter = 0;
    let exit = Infinity;
    for (const [p0, d, lo, hi] of [
      [sx, flowDir.x, bounds.minX, bounds.maxX],
      [sy, flowDir.y, bounds.minY, bounds.maxY],
    ] as const) {
      if (Math.abs(d) < 1e-9) {
        if (p0 < lo || p0 > hi) {
          enter = Infinity;
          break;
        }
        continue;
      }
      const t1 = (lo - p0) / d;
      const t2 = (hi - p0) / d;
      enter = Math.max(enter, Math.min(t1, t2));
      exit = Math.min(exit, Math.max(t1, t2));
    }
    if (enter >= exit || !isFinite(enter)) continue;

    let x = sx + flowDir.x * (enter + 0.01);
    let y = sy + flowDir.y * (enter + 0.01);
    const points: Point2[] = [];
    let ratioSum = 0;
    for (let step = 0; step < STREAM_MAX_STEPS; step++) {
      if (isBlockedAt(field, x, y)) break;
      const vel = sampleWind(field, x, y);
      if (!vel) break;
      const speed = Math.hypot(vel.x, vel.y);
      if (speed < STREAM_STALL_RATIO * field.windSpeedMs) break;
      points.push({ x, y });
      ratioSum += speed / field.windSpeedMs;
      x += (vel.x / speed) * STREAM_STEP_M;
      y += (vel.y / speed) * STREAM_STEP_M;
    }
    if (points.length >= 2) {
      lines.push({ points, speedRatio: ratioSum / points.length });
    }
  }
  return lines;
}

// ---------- 결과 조립 타입 ----------

export interface WindResult {
  /** 주풍향 (도, 0=북·90=동 — 불어오는 방향) */
  windDir: number;
  /** 평균 풍속 (m/s) */
  windSpeedMs: number;
  /** 대상 월 (1~12) — null이면 연간 */
  month: number | null;
  streamlines: Streamline[];
  /** 바람그림자(속도비 < 0.3) 면적 (㎡) */
  shadowAreaM2: number;
}

// ---------- Three.js 오버레이 ----------

/** 속도비 → 색 (파랑=정체 → 초록=주풍속 → 빨강=가속) */
export function windColorHex(speedRatio: number): number {
  if (speedRatio < 0.3) return 0x3b82f6;
  if (speedRatio < 0.7) return 0x06b6d4;
  if (speedRatio <= 1.3) return 0x22c55e;
  if (speedRatio <= 2.0) return 0xf59e0b;
  return 0xef4444;
}

const WIND_OVERLAY_Y = 0.5;
/** 유선 튜브 반지름 (m) — GL 라인은 굵기 지정이 안 먹혀 튜브 메시로 그린다 */
const WIND_TUBE_RADIUS = 0.35;

/**
 * 스트림라인을 지면 위 튜브 묶음으로 표시 — scene에 추가하고 그룹을 반환.
 * @param elevate (x,y DXF)→지형 고도(m). 주면 유선을 지형 표면을 따라 드레이프한다
 *   (표시 전용 — 속도장 계산은 지형과 무관한 2D).
 */
export function createWindOverlay(
  result: WindResult,
  scene: THREE.Scene,
  elevate?: (x: number, y: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "wind-overlay";
  for (const line of result.streamlines) {
    if (line.points.length < 2) continue;
    const pts = line.points.map(
      (p) =>
        new THREE.Vector3(
          p.x,
          (elevate ? elevate(p.x, p.y) : 0) + WIND_OVERLAY_Y,
          -p.y, // DXF y+ → three -z
        ),
    );
    const geom = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(pts),
      Math.min(pts.length * 2, 400),
      WIND_TUBE_RADIUS,
      5,
      false,
    );
    const mat = new THREE.MeshBasicMaterial({
      color: windColorHex(line.speedRatio),
      transparent: true,
      opacity: 0.95,
    });
    group.add(new THREE.Mesh(geom, mat));
  }
  scene.add(group);
  return group;
}

export function disposeWindOverlay(group: THREE.Group): void {
  group.removeFromParent();
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  group.clear();
}
