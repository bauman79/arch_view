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
  /** 2.5D 높이 계수 (0~1, 1=벽) */
  hf: number;
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
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
  refHeightM = 0,
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
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of fp) {
      bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y);
      bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y);
    }
    obstacles.push({
      fp,
      hf: refHeightM > 0 ? Math.min(1, (b.floors * b.floorHeight) / refHeightM) : 1,
      bx0, by0, bx1, by1,
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

      let insideHf = 0;
      for (const o of obstacles) {
        if (x < o.bx0 || x > o.bx1 || y < o.by0 || y > o.by1) continue;
        if (pointInPolygon(x, y, o.fp)) insideHf = Math.max(insideHf, o.hf);
      }
      if (insideHf >= 1) {
        blocked[idx] = 1;
        continue; // u=v=0
      }

      let vx = flow.x * windSpeed;
      let vy = flow.y * windSpeed;
      // 2.5D — 저층 건물 안(지붕 위로 넘어가는 바람)은 높이에 비례해 감속
      let attenuation = insideHf > 0 ? 1 - 0.7 * insideHf : 1;
      for (const o of obstacles) {
        // 영향이 1% 미만인 먼 건물은 건너뜀 (bbox 거리 기준 — 630동 배치도 속도)
        const bdx = Math.max(o.bx0 - x, 0, x - o.bx1);
        const bdy = Math.max(o.by0 - y, 0, y - o.by1);
        const bd = Math.hypot(bdx, bdy);
        if (bd > 9 * o.influenceR && bd > 6 * o.halfWidth + o.halfDepth + o.halfWidth) continue;
        // 밀어내기 편향 — 경계 최단거리 r에 반비례 감쇠 (2.5D: 높이 계수 배)
        const r = distToPolygonBoundary(x, y, o.fp);
        const w = (o.hf * 1) / (1 + r / o.influenceR) ** 2;
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
            const a = 0.95 * o.hf * lateral * (1 - behind / wakeLen);
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
  /** 바람이 흘러가는 순서(상류 → 하류) */
  points: Point2[];
  /** 점마다 국지 속도 / 주풍속 — 유선 색을 구간별로 칠하는 데 쓴다 */
  ratios: number[];
  /** 경로 평균 속도 / 주풍속 (배율) */
  speedRatio: number;
}

/** 이 비율 미만으로 느려지면 정체로 보고 중단 */
const STREAM_STALL_RATIO = 0.02;

/**
 * 고른 간격 유선(evenly-spaced streamlines, Jobard–Lefer 방식 단순화).
 *
 * - 유선 간격 dSep = 흐름 직각 폭 / lineCount (격자 1.5배 이상)
 * - 시드: 상류 경계를 따라 먼저, 이어서 도메인 전체 격자 — 건물 뒤 소용돌이·정체
 *   영역에도 선이 들어가 첨부 사례처럼 회전 흐름이 보인다
 * - 각 시드에서 앞·뒤 양방향으로 RK2 적분, 다른 유선(또는 한 바퀴 돈 자기 자신)과
 *   dSep/2보다 가까워지면 멈춘다 → 선이 겹치지 않고 소용돌이는 고리로 닫힌다
 */
export function traceStreamlines(field: WindField, lineCount: number): Streamline[] {
  const { bounds, flowDir } = field;
  const W = bounds.maxX - bounds.minX;
  const H = bounds.maxY - bounds.minY;
  const cross = Math.abs(W * flowDir.y) + Math.abs(H * flowDir.x);
  const dSep = Math.max(field.gridM * 1.5, cross / Math.max(1, lineCount));
  const dTest = dSep * 0.5;
  const step = Math.min(field.gridM * 0.5, dSep * 0.1);
  const maxSteps = Math.ceil(((W + H) * 2) / step);
  const selfSkip = Math.ceil((dSep * 2.5) / step);
  const stall = STREAM_STALL_RATIO * field.windSpeedMs;

  // 점 점유 격자 — 셀 크기 dTest, 3×3 이웃만 보면 된다
  const cs = dTest;
  const gw = Math.ceil(W / cs) + 1;
  const gh = Math.ceil(H / cs) + 1;
  const grid = new Map<number, { x: number; y: number; line: number; idx: number }[]>();
  const cellOf = (x: number, y: number) =>
    Math.floor((y - bounds.minY) / cs) * gw + Math.floor((x - bounds.minX) / cs);
  const tooClose = (x: number, y: number, line: number, idx: number, r: number): boolean => {
    const cx = Math.floor((x - bounds.minX) / cs);
    const cy = Math.floor((y - bounds.minY) / cs);
    const r2 = r * r;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= gh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= gw) continue;
        const list = grid.get(yy * gw + xx);
        if (!list) continue;
        for (const q of list) {
          if (q.line === line && Math.abs(q.idx - idx) <= selfSkip) continue;
          if ((q.x - x) ** 2 + (q.y - y) ** 2 < r2) return true;
        }
      }
    }
    return false;
  };
  const occupy = (x: number, y: number, line: number, idx: number) => {
    const k = cellOf(x, y);
    const list = grid.get(k);
    const e = { x, y, line, idx };
    if (list) list.push(e);
    else grid.set(k, [e]);
  };
  const inDomain = (x: number, y: number) =>
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  const dirAt = (x: number, y: number): { dx: number; dy: number; sp: number } | null => {
    if (isBlockedAt(field, x, y)) return null;
    const v = sampleWind(field, x, y);
    if (!v) return null;
    const sp = Math.hypot(v.x, v.y);
    if (sp < stall) return null;
    return { dx: v.x / sp, dy: v.y / sp, sp };
  };

  /** 한 방향 적분 — sign=+1 순방향, -1 역방향 */
  const integrate = (
    x0: number,
    y0: number,
    sign: 1 | -1,
    line: number,
  ): { pts: Point2[]; rs: number[] } => {
    const pts: Point2[] = [];
    const rs: number[] = [];
    let x = x0;
    let y = y0;
    for (let k = 1; k <= maxSteps; k++) {
      const d1 = dirAt(x, y);
      if (!d1) break;
      const mx = x + sign * d1.dx * step * 0.5;
      const my = y + sign * d1.dy * step * 0.5;
      const d2 = dirAt(mx, my);
      if (!d2) break;
      const nx = x + sign * d2.dx * step;
      const ny = y + sign * d2.dy * step;
      if (!inDomain(nx, ny)) break;
      const idx = sign * k;
      if (tooClose(nx, ny, line, idx, dTest)) break;
      x = nx;
      y = ny;
      pts.push({ x, y });
      rs.push(d2.sp / field.windSpeedMs);
      occupy(x, y, line, idx);
    }
    return { pts, rs };
  };

  // 시드 후보 — 상류 경계(흐름 직각으로 dSep 간격) → 도메인 전체 격자
  const seeds: Point2[] = [];
  const perp = { x: -flowDir.y, y: flowDir.x };
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const half = cross / 2;
  const far = Math.hypot(W, H);
  for (let t = -half + dSep / 2; t < half; t += dSep) {
    // 상류 먼 곳에서 흐름 방향으로 쏜 반직선의 도메인 진입점 (slab 교차)
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
    seeds.push({ x: sx + flowDir.x * (enter + 0.01), y: sy + flowDir.y * (enter + 0.01) });
  }
  const upstreamSeeds = seeds.length;
  for (let y = bounds.minY + dSep / 2; y < bounds.maxY; y += dSep) {
    for (let x = bounds.minX + dSep / 2; x < bounds.maxX; x += dSep) seeds.push({ x, y });
  }

  const minLen = Math.ceil((dSep * 2) / step);
  const lines: Streamline[] = [];
  let lineId = 0;
  for (let si = 0; si < seeds.length; si++) {
    const s0 = seeds[si];
    const d0 = dirAt(s0.x, s0.y);
    if (!d0) continue;
    if (tooClose(s0.x, s0.y, -1, 0, dSep * 0.9)) continue;
    const id = lineId++;
    occupy(s0.x, s0.y, id, 0);
    const back = integrate(s0.x, s0.y, -1, id);
    const fwd = integrate(s0.x, s0.y, 1, id);
    const points = [...back.pts.reverse(), { x: s0.x, y: s0.y }, ...fwd.pts];
    const ratios = [...back.rs.reverse(), d0.sp / field.windSpeedMs, ...fwd.rs];
    // 내부 시드의 짧은 조각은 버린다(자국만 남김 — 점유는 유지해 주변이 너무 빽빽해지지 않게)
    if (points.length < 2 || (si >= upstreamSeeds && points.length < minLen)) continue;
    const avg = ratios.reduce((a, r) => a + r, 0) / ratios.length;
    lines.push({ points, ratios, speedRatio: avg });
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

/**
 * 풍속비 컬러맵 — 파랑(정체) → 청록 → 초록(주풍속) → 노랑 → 주황 → 빨강(2배 이상 가속).
 * 유선 색과 화면 범례가 같은 값을 쓴다.
 */
export const WIND_RATIO_STOPS: [number, number][] = [
  [0.0, 0x1d4ed8],
  [0.5, 0x06b6d4],
  [1.0, 0x22c55e],
  [1.3, 0xeab308],
  [1.6, 0xf97316],
  [2.0, 0xef4444],
];
const windStopColors = WIND_RATIO_STOPS.map(([, h]) => new THREE.Color(h));

export function windRatioColor(ratio: number, out = new THREE.Color()): THREE.Color {
  const st = WIND_RATIO_STOPS;
  if (ratio <= st[0][0]) return out.copy(windStopColors[0]);
  for (let i = 1; i < st.length; i++) {
    if (ratio <= st[i][0]) {
      const t = (ratio - st[i - 1][0]) / (st[i][0] - st[i - 1][0]);
      return out.lerpColors(windStopColors[i - 1], windStopColors[i], t);
    }
  }
  return out.copy(windStopColors[windStopColors.length - 1]);
}

/** 속도비 → 대표색 (평균 속도 표시용) */
export function windColorHex(speedRatio: number): number {
  return windRatioColor(speedRatio).getHex();
}

/** 유선 높이 — 보행자 높이 부근, 지면 히트맵(0.2m)보다 위 */
const WIND_OVERLAY_Y = 1.2;
const ARROW_EVERY = 3.5; // 유선 간격의 몇 배마다 화살표

/**
 * 스트림라인을 풍속비 그라데이션 튜브 + 진행 방향 화살표로 표시.
 * 튜브는 한 지오메트리로 합쳐 그린다(유선 수백 개도 draw call 1회).
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
  const lines = result.streamlines.filter((l) => l.points.length >= 2);

  // 유선 간격 추정 — 튜브 굵기·화살표 크기 기준 (이웃 유선 시작점 간 평균 거리는 불안정해 길이로 대신)
  let totalLen = 0;
  for (const l of lines) {
    for (let i = 1; i < l.points.length; i++) {
      totalLen += Math.hypot(l.points[i].x - l.points[i - 1].x, l.points[i].y - l.points[i - 1].y);
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lines) for (const p of l.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const area = lines.length ? Math.max(1, (maxX - minX) * (maxY - minY)) : 1;
  const spacing = totalLen > 0 ? Math.min(40, Math.max(3, area / totalLen)) : 10;
  const radius = Math.min(0.9, Math.max(0.18, spacing * 0.035));

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const arrows: { pos: THREE.Vector3; dir: THREE.Vector3; color: THREE.Color }[] = [];
  const col = new THREE.Color();
  const RADIAL = 5;

  for (const line of lines) {
    const ratios = line.ratios ?? line.points.map(() => line.speedRatio);
    const pts = line.points.map(
      (p) => new THREE.Vector3(p.x, (elevate ? elevate(p.x, p.y) : 0) + WIND_OVERLAY_Y, -p.y),
    );
    // 누적 길이 — 튜브 링 위치(호장 비율)에서 속도비를 찾기 위해
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const len = cum[cum.length - 1];
    if (len < 1e-3) continue;
    const ratioAt = (s: number): number => {
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (cum[m] <= s) lo = m;
        else hi = m;
      }
      const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
      return ratios[lo] + (ratios[hi] - ratios[lo]) * t;
    };
    const segs = Math.max(4, Math.min(600, Math.round(len / 1.5)));
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, radius, RADIAL, false);
    const base = positions.length / 3;
    const pa = tube.getAttribute("position");
    for (let i = 0; i < pa.count; i++) {
      positions.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      const ring = Math.floor(i / (RADIAL + 1));
      windRatioColor(ratioAt((ring / segs) * len), col);
      colors.push(col.r, col.g, col.b);
    }
    const ia = tube.getIndex()!;
    for (let i = 0; i < ia.count; i++) indices.push(base + ia.getX(i));
    tube.dispose();

    // 화살표 — 유선을 따라 일정 간격
    const every = spacing * ARROW_EVERY;
    for (let s = every * 0.5; s < len - radius * 4; s += every) {
      let k = 0;
      while (k < cum.length - 2 && cum[k + 1] < s) k++;
      const t = (s - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]);
      const pos = pts[k].clone().lerp(pts[k + 1], t);
      const dir = pts[k + 1].clone().sub(pts[k]).normalize();
      arrows.push({ pos, dir, color: windRatioColor(ratioAt(s)) });
    }
  }

  if (positions.length > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true }));
    mesh.name = "wind-tubes";
    group.add(mesh);
  }
  if (arrows.length > 0) {
    const cone = new THREE.ConeGeometry(radius * 3.2, radius * 9, 10);
    const inst = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial(), arrows.length);
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    arrows.forEach((a, i) => {
      q.setFromUnitVectors(up, a.dir);
      m.compose(a.pos, q, one);
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, a.color);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.name = "wind-arrows";
    group.add(inst);
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
