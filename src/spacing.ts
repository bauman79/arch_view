import * as THREE from "three";
import { worldFootprint } from "./buildings";
import { pointInPolygon } from "./geom2d";
import { buildingHeight, type Building, type Point2, type Project } from "./types";
import { edgeHasWindow } from "./windows";

/**
 * 인동거리 검토 (M3) — 건축법 시행령 제86조 제3항 제2호.
 * 같은 대지의 계획주동 쌍마다 **서로 마주보는 벽면**을 찾아, 벽면 직각방향 이격거리를 판정한다.
 *
 * ⚠️ 법은 "벽면으로부터 직각방향" 거리 기준이므로, 두 벽면을 서로 직각방향으로 확장했을 때
 * 실제로 겹치는(마주보는) 경우에만 검토한다 — 대각선으로 어긋나 마주보지 않는 건물 쌍은
 * 검토 대상이 아니다(예전 구현이 폴리곤 최단거리로 대각선까지 판정하던 오류를 수정).
 *
 * 마주보는 벽면 쌍의 적용 기준:
 *   - 가목: 어느 한쪽이라도 채광창 있는 벽면 → 이격 ≥ spacingRatioWindow × 높은 동 높이
 *     (시행령 하한 0.5배, 서울시 조례 0.8배)
 *   - 라목: 채광창 없는 벽면 ↔ 측벽 → 8m 이상 (창없는 벽면끼리도 보수적으로 이 값 적용)
 *   - 마목: 측벽 ↔ 측벽 → 4m 이상
 *   측벽 판별은 기하 근사 — 벽 길이가 그 건물 최장 벽의 절반 이하이면 측벽으로 간주.
 *   나목(남측 저층·개구부 방향 특례)·다목(부대·복리시설)은 미반영(문서화된 한계).
 *
 * PLAN_WIN 창면 데이터가 없는 동(windowSegments 비어있음)은 하위호환으로 모든 벽을
 * "채광창 있음"으로 간주한다(보수적 — 가목 적용).
 *
 * ⚠️ 정북사선(northsetback.ts)·태양 계산과 완전히 독립된 순수 기하 계산 —
 * 드래그·회전 중 매 프레임 호출 가능.
 */

export type SpacingRule = "채광" | "창없음" | "측벽";

/** 마주보는 구간으로 인정할 최소 겹침 길이 (m) */
const MIN_OVERLAP = 0.1;

export interface SpacingCheck {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  /** 마주보는 구간의 벽면 직각방향 최소 이격거리 (m) */
  distance: number;
  /** 기준 이격거리 (m) */
  required: number;
  /** 적용 기준 — 가목(채광)/라목(창없음)/마목(측벽) */
  rule: SpacingRule;
  /** 기준높이 (m) — 두 동 중 높은 동 (채광 규칙에서 사용) */
  height: number;
  /** 마주보는 구간 길이 (m) */
  overlapLen: number;
  pass: boolean;
  /** 최소 이격 지점 쌍 (DXF 평면, 월드 좌표) — 시각화용 */
  pa: Point2;
  pb: Point2;
}

export interface SpacingResult {
  ratioWindow: number;
  noWindowM: number;
  sideM: number;
  checks: SpacingCheck[];
  violations: number;
}

interface PlanEntry {
  id: string;
  name: string;
  building: Building;
  fp: Point2[];
  height: number;
  /** 에지별 창 유무 (windowSegments 비어있으면 전부 true — 하위호환) */
  edgeWin: boolean[];
  /** 에지별 측벽 여부 (길이 ≤ 최장 벽 × 0.5) */
  edgeSide: boolean[];
  /** 에지별 바깥 법선 (단위벡터) */
  normals: Point2[];
  /** 에지별 길이 */
  lens: number[];
}

function signedArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function mkEntry(b: Building): PlanEntry {
  const fp = worldFootprint(b);
  const n = fp.length;
  const windingSign = signedArea(fp) >= 0 ? 1 : -1;
  const lens: number[] = [];
  const normals: Point2[] = [];
  const edgeWin: boolean[] = [];
  const edgeSide: boolean[] = [];
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const p1 = fp[i];
    const p2 = fp[(i + 1) % n];
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    const len = Math.hypot(ex, ey);
    lens.push(len);
    maxLen = Math.max(maxLen, len);
    // CCW(양의 면적) 폴리곤에서 에지 진행방향의 오른쪽이 바깥
    normals.push(
      len > 1e-9
        ? { x: (windingSign * ey) / len, y: (-windingSign * ex) / len }
        : { x: 0, y: 0 },
    );
    edgeWin.push(
      b.windowSegments.length === 0
        ? true // 창 데이터 미지정 — 보수적으로 창 있음(가목) 간주
        : edgeHasWindow(b.footprint[i], b.footprint[(i + 1) % n], b.windowSegments),
    );
  }
  for (let i = 0; i < n; i++) edgeSide.push(lens[i] <= maxLen * 0.5 + 1e-9);
  return {
    id: b.id,
    name: b.name,
    building: b,
    fp,
    height: buildingHeight(b),
    edgeWin,
    edgeSide,
    normals,
    lens,
  };
}

/**
 * source의 i번째 벽면에서 직각방향으로 확장했을 때 target의 j번째 벽면과 마주보는지 판정.
 * 마주보면(겹침 ≥ MIN_OVERLAP, 겹침 구간 전체가 벽 바깥쪽) 최소 직각거리를 반환.
 */
function facingDistance(
  src: PlanEntry,
  i: number,
  tgt: PlanEntry,
  j: number,
): { distance: number; overlapLen: number; pSrc: Point2; pTgt: Point2 } | null {
  const na = src.normals[i];
  const nb = tgt.normals[j];
  // 법선이 서로 반대 방향 성분을 가져야 "마주보는" 벽면
  if (na.x * nb.x + na.y * nb.y >= -1e-9) return null;

  const p1 = src.fp[i];
  const p2 = src.fp[(i + 1) % src.fp.length];
  const len = src.lens[i];
  if (len < 1e-9) return null;
  const dir = { x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len };

  const q1 = tgt.fp[j];
  const q2 = tgt.fp[(j + 1) % tgt.fp.length];
  // target 끝점을 source 벽면 좌표계로: t = 벽면 방향 성분, s = 직각(바깥) 방향 성분
  const t1 = (q1.x - p1.x) * dir.x + (q1.y - p1.y) * dir.y;
  const s1 = (q1.x - p1.x) * na.x + (q1.y - p1.y) * na.y;
  const t2 = (q2.x - p1.x) * dir.x + (q2.y - p1.y) * dir.y;
  const s2 = (q2.x - p1.x) * na.x + (q2.y - p1.y) * na.y;

  // 파라미터 u∈[0,1]에서 t(u)가 [0,len]에 들어오는 구간으로 클리핑
  let uLo = 0;
  let uHi = 1;
  const dt = t2 - t1;
  // 벽면 방향과 직교하는 target — 겹침 길이 0이라 마주봄 아님
  if (Math.abs(dt) < 1e-9) return null;
  const uAt0 = (0 - t1) / dt;
  const uAtLen = (len - t1) / dt;
  uLo = Math.max(uLo, Math.min(uAt0, uAtLen));
  uHi = Math.min(uHi, Math.max(uAt0, uAtLen));
  if (uHi <= uLo) return null;

  // s ≥ 0 (벽 바깥쪽) 구간으로 추가 클리핑
  const ds = s2 - s1;
  if (Math.abs(ds) > 1e-9) {
    const uAtS0 = (0 - s1) / ds;
    if (ds > 0) uLo = Math.max(uLo, uAtS0);
    else uHi = Math.min(uHi, uAtS0);
    if (uHi <= uLo) return null;
  } else if (s1 < 0) {
    return null;
  }

  const tLo = t1 + dt * uLo;
  const tHi = t1 + dt * uHi;
  const overlapLen = Math.abs(tHi - tLo);
  if (overlapLen < MIN_OVERLAP) return null;

  // s(u)는 선형 — 최소는 클리핑 구간 양 끝 중 하나
  const sLo = s1 + ds * uLo;
  const sHi = s1 + ds * uHi;
  const uMin = sLo <= sHi ? uLo : uHi;
  const sMin = Math.min(sLo, sHi);
  if (sMin < 0) return null;

  const pTgt = { x: q1.x + (q2.x - q1.x) * uMin, y: q1.y + (q2.y - q1.y) * uMin };
  const pSrc = { x: pTgt.x - na.x * sMin, y: pTgt.y - na.y * sMin };
  return { distance: sMin, overlapLen, pSrc, pTgt };
}

/** 벽면 쌍의 적용 기준과 요구 이격거리 */
function ruleFor(
  src: PlanEntry,
  i: number,
  tgt: PlanEntry,
  j: number,
  ratioWindow: number,
  noWindowM: number,
  sideM: number,
): { rule: SpacingRule; required: number } {
  const winSrc = src.edgeWin[i];
  const winTgt = tgt.edgeWin[j];
  const height = Math.max(src.height, tgt.height);
  if (winSrc || winTgt) return { rule: "채광", required: height * ratioWindow };
  if (src.edgeSide[i] && tgt.edgeSide[j]) return { rule: "측벽", required: sideM };
  return { rule: "창없음", required: noWindowM };
}

/** 인동거리 검토 실행 — 모든 계획주동 쌍의 마주보는 벽면 */
export function runSpacingCheck(project: Project): SpacingResult {
  const {
    spacingRatioWindow: ratioWindow,
    spacingNoWindowM: noWindowM,
    spacingSideM: sideM,
  } = project.analysis.setbackRules;

  const plans = project.buildings
    .filter((b) => b.type === "계획주동")
    .map(mkEntry)
    .filter((p) => p.fp.length >= 3);

  const checks: SpacingCheck[] = [];
  for (let ai = 0; ai < plans.length; ai++) {
    for (let bi = ai + 1; bi < plans.length; bi++) {
      const A = plans[ai];
      const B = plans[bi];

      // 평면상 겹침(포함 포함) — 이격 0으로 즉시 위반
      if (
        pointInPolygon(A.fp[0].x, A.fp[0].y, B.fp) ||
        pointInPolygon(B.fp[0].x, B.fp[0].y, A.fp)
      ) {
        const height = Math.max(A.height, B.height);
        checks.push({
          aId: A.id,
          aName: A.name,
          bId: B.id,
          bName: B.name,
          distance: 0,
          required: height * ratioWindow,
          rule: "채광",
          height,
          overlapLen: 0,
          pass: false,
          pa: A.fp[0],
          pb: A.fp[0],
        });
        continue;
      }

      // 양방향으로 마주보는 벽면 쌍 수집 (직각방향 확장 겹침이 있는 것만)
      let worst: SpacingCheck | null = null;
      const consider = (
        src: PlanEntry,
        tgt: PlanEntry,
        srcIsA: boolean,
      ) => {
        for (let i = 0; i < src.fp.length; i++) {
          for (let j = 0; j < tgt.fp.length; j++) {
            const f = facingDistance(src, i, tgt, j);
            if (!f) continue;
            const { rule, required } = ruleFor(
              src,
              i,
              tgt,
              j,
              ratioWindow,
              noWindowM,
              sideM,
            );
            const check: SpacingCheck = {
              aId: A.id,
              aName: A.name,
              bId: B.id,
              bName: B.name,
              distance: f.distance,
              required,
              rule,
              height: Math.max(A.height, B.height),
              overlapLen: f.overlapLen,
              pass: f.distance >= required - 1e-9,
              pa: srcIsA ? f.pSrc : f.pTgt,
              pb: srcIsA ? f.pTgt : f.pSrc,
            };
            // 가장 불리한(여유 = 거리 − 기준 최소) 벽면 쌍을 대표로 채택
            if (
              !worst ||
              check.distance - check.required < worst.distance - worst.required
            ) {
              worst = check;
            }
          }
        }
      };
      consider(A, B, true);
      consider(B, A, false);

      // 마주보는 벽면이 전혀 없으면(대각선 배치 등) 검토 대상 아님
      if (worst) checks.push(worst);
    }
  }
  return {
    ratioWindow,
    noWindowM,
    sideM,
    checks,
    violations: checks.filter((c) => !c.pass).length,
  };
}

// ---------- 시각화 ----------

const PASS_COLOR = 0x9aa0a6; // 적합 — 회색
const FAIL_COLOR = 0xe5484d; // 위반 — 빨강
/** 이격선 표시 높이 (m) */
const LINE_Y = 0.8;

// 매 프레임 재생성되므로 지오메트리·머티리얼은 모듈 공유(디스포즈 금지)
const lineGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
const endGeom = new THREE.SphereGeometry(1, 10, 8);
const passMat = new THREE.MeshBasicMaterial({
  color: PASS_COLOR,
  transparent: true,
  opacity: 0.8,
});
const failMat = new THREE.MeshBasicMaterial({ color: FAIL_COLOR });

/**
 * 마주보는 벽면 쌍의 직각방향 이격선 오버레이 (빨강=위반, 회색=적합).
 * 공유 지오메트리·머티리얼만 쓰므로 그룹 제거 시 dispose 불필요.
 */
export function createSpacingOverlay(result: SpacingResult): THREE.Group {
  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  for (const c of result.checks) {
    const mat = c.pass ? passMat : failMat;
    const radius = c.pass ? 0.15 : 0.3;
    const a = new THREE.Vector3(c.pa.x, LINE_Y, -c.pa.y); // DXF y+ → three -z
    const b = new THREE.Vector3(c.pb.x, LINE_Y, -c.pb.y);
    const len = a.distanceTo(b);

    if (len > 1e-6) {
      const line = new THREE.Mesh(lineGeom, mat);
      line.scale.set(radius, len, radius);
      line.quaternion.setFromUnitVectors(
        up,
        b.clone().sub(a).normalize(),
      );
      line.position.copy(a).add(b).multiplyScalar(0.5);
      group.add(line);
    }
    for (const p of [a, b]) {
      const end = new THREE.Mesh(endGeom, mat);
      end.scale.setScalar(radius * 2.5);
      end.position.copy(p);
      group.add(end);
    }
  }
  return group;
}
