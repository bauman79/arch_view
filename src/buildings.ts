import * as THREE from "three";
import { signedArea } from "./geom2d";
import { buildingHeight, type Building, type OverlayLine, type Point2 } from "./types";
import { edgeHasWindow } from "./windows";

/** 계획주동 — 노랑 (일조권 검토 결과의 파란색 셀과 혼동 방지) */
const PLAN_COLOR = 0xe0b53c;
const ADJ_COLOR = 0x9aa0a6;
const EDGE_COLOR = 0x14161a;
/** PLAN_WIN/ADJ_WIN로 표시된 창면 하이라이트 색 — 연한 파랑, 반투명 */
const WINDOW_HILITE_COLOR = 0x9fd6ff;

export const SELECT_EMISSIVE = 0x5a4a14;

/** data/DXF_RULES.md 표의 레이어 색상과 맞춘 오버레이 선 색 */
const OVERLAY_COLOR: Record<OverlayLine["layer"], number> = {
  SITE_BOUNDARY: 0xe0e0e0,
  ADJ_BOUNDARY: 0xe6c84a,
  ROAD_CL: 0x4ac8e6,
  PARK_BOUNDARY: 0x4ac86a,
  CONTOUR: 0xa07a4a,
};

/**
 * 대지(SITE_BOUNDARY) 내부 바닥 채움 — 씬 배경(0x070d1a)보다 충분히 밝은 중간 회색이라야
 * 그림자(그림자 영역은 반구광만 받아 어두워짐)가 대비로 드러난다.
 */
const SITE_FILL_COLOR = 0x7a828c;
/**
 * 대지 채움 높이 — 격자(0) 위, 오버레이 선(0.05) 아래.
 * 지면판(-0.05)과의 간격 0.07m는 카메라 near=0.1·far=5000에서 원거리(수백 m) 깊이
 * 분해능(≈0.05m)에 근접해 z-fighting이 나므로, 높이차만 믿지 않고 polygonOffset을 함께 쓴다.
 */
const SITE_FILL_Y = 0.02;

/**
 * SITE_BOUNDARY 등 참고용 2D 오버레이 선(대지경계·인접대지·도로중심선·공원경계) 렌더링.
 * z=0(지면) 바로 위에 얇게 표시 — 건물처럼 압출·인터랙션하지 않는다.
 * 닫힌 SITE_BOUNDARY는 내부를 회색 면으로 채워 그림자 확인용 바닥으로 쓴다.
 */
export function createOverlayGroup(overlays: OverlayLine[]): THREE.Group {
  const group = new THREE.Group();
  const y = 0.05;
  for (const o of overlays) {
    if (o.layer === "SITE_BOUNDARY") {
      const fill = createSiteFill(o);
      if (fill) group.add(fill);
    }
    const pts = o.points.map((p) => new THREE.Vector3(p.x, y, -p.y));
    if (o.closed) pts.push(pts[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: OVERLAY_COLOR[o.layer] });
    const line = new THREE.Line(geom, mat);
    line.name = `overlay-${o.layer}`;
    group.add(line);
  }
  return group;
}

/**
 * 대지경계 폴리곤 내부를 채우는 회색 면. 그림자를 받도록 receiveShadow.
 * SITE_BOUNDARY는 규약상 닫힌 폴리라인이지만, 열려 있어도 닫힌 것으로 보고 채운다
 * (DXF 파싱 단계에서 이미 "닫힌 것으로 간주" 경고를 내보내므로 여기서 또 막지 않는다).
 */
function createSiteFill(o: OverlayLine): THREE.Mesh | null {
  if (o.points.length < 3) return null;
  const shape = new THREE.Shape();
  o.points.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, p.y);
    else shape.lineTo(p.x, p.y);
  });
  shape.closePath();

  // ShapeGeometry는 XY평면에 법선 +Z로 생성 — rotateX(-90°)로 (x,y)→(x,0,-y), 법선은 +Y(상향).
  // 폴리곤 winding과 무관하게 법선이 위를 보므로 DoubleSide로 둬도 조명이 뒤집히지 않는다.
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshLambertMaterial({
      color: SITE_FILL_COLOR,
      side: THREE.DoubleSide,
      // 아래 지면판과 깊이가 근접해 얼룩(z-fighting)이 생기는 것을 막는다 — 항상 지면판 위로
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  mesh.position.y = SITE_FILL_Y;
  mesh.receiveShadow = true;
  mesh.name = "site-fill";
  return mesh;
}

/** 필로티 개방부 높이 (m) */
export function pilotiHeight(b: Building): number {
  return Math.min(b.pilotiFloors, b.floors) * b.floorHeight;
}

/**
 * Building → 3D 매스(Group).
 * 그룹 원점 = footprint 중심(centroid)로 두어 offset 이동/회전이 자연스럽게 적용된다.
 * 필로티 층수만큼 하부는 매스를 비우고 꼭짓점 위치에 기둥만 세운다(개방부 시각화).
 * userData.buildingId 로 역참조.
 */
export function createBuildingObject(b: Building): THREE.Group {
  const centroid = footprintCentroid(b.footprint);
  const height = Math.max(buildingHeight(b), 0.1);
  const piloti = Math.min(pilotiHeight(b), height - 0.1);

  const shape = new THREE.Shape();
  b.footprint.forEach((p, i) => {
    const x = p.x - centroid.x;
    const y = p.y - centroid.y;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height - piloti,
    bevelEnabled: false,
  });
  if (piloti > 0) geom.translate(0, 0, piloti);
  // XY 평면 + Z압출 → Y-up 으로 회전 (DXF y+ → three -z)
  geom.rotateX(-Math.PI / 2);

  const isPlan = b.type === "계획주동";
  const mat = new THREE.MeshLambertMaterial({
    color: isPlan ? PLAN_COLOR : ADJ_COLOR,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "mass";
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 30),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
  );

  const group = new THREE.Group();
  group.add(mesh, edges);

  // 필로티 기둥 (시각화 전용 — 일조 차폐에는 포함하지 않음, plan.md 8장 근사)
  if (piloti > 0) {
    const colGeom = new THREE.BoxGeometry(0.5, piloti, 0.5);
    const colMat = new THREE.MeshLambertMaterial({
      color: isPlan ? PLAN_COLOR : ADJ_COLOR,
    });
    for (const p of b.footprint) {
      const col = new THREE.Mesh(colGeom, colMat);
      col.position.set(
        p.x - centroid.x,
        piloti / 2,
        -(p.y - centroid.y),
      );
      col.castShadow = true;
      group.add(col);
    }
  }

  // PLAN_WIN/ADJ_WIN로 표시된 창면 하이라이트 — 벽면 위에 반투명 패널을 살짝 띄워 겹친다
  if (b.windowSegments.length > 0) {
    const winMat = new THREE.MeshBasicMaterial({
      color: WINDOW_HILITE_COLOR,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const wallH = height - piloti;
    const n = b.footprint.length;
    const windingSign = signedArea(b.footprint) >= 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const p1 = b.footprint[i];
      const p2 = b.footprint[(i + 1) % n];
      if (!edgeHasWindow(p1, p2, b.windowSegments)) continue;
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6 || wallH < 1e-6) continue;
      const nx = (windingSign * ey) / len;
      const ny = (-windingSign * ex) / len;

      const winGeom = new THREE.PlaneGeometry(len, wallH);
      const winMesh = new THREE.Mesh(winGeom, winMat);
      winMesh.name = "window-hilite";
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(ex, 0, -ey).normalize(), // 로컬 X = 에지 진행방향
        new THREE.Vector3(0, 1, 0), // 로컬 Y = 연직 상향
        new THREE.Vector3(nx, 0, -ny).normalize(), // 로컬 Z = 바깥 법선(면이 바라보는 방향)
      );
      winMesh.quaternion.setFromRotationMatrix(basis);
      const mx = (p1.x + p2.x) / 2 - centroid.x;
      const my = (p1.y + p2.y) / 2 - centroid.y;
      winMesh.position.set(mx, piloti + wallH / 2, -my).addScaledVector(
        new THREE.Vector3(nx, 0, -ny).normalize(),
        0.03,
      );
      group.add(winMesh);
    }
  }

  group.userData.buildingId = b.id;
  applyOffset(group, b, centroid);
  return group;
}

/** offset(dx, dy, rotation)을 그룹 트랜스폼에 반영 */
export function applyOffset(
  group: THREE.Group,
  b: Building,
  centroid?: Point2,
): void {
  const c = centroid ?? footprintCentroid(b.footprint);
  group.position.set(
    c.x + b.offset.dx,
    0,
    -(c.y + b.offset.dy), // DXF y+ → three -z
  );
  group.rotation.y = THREE.MathUtils.degToRad(b.offset.rotation);
}

export function footprintCentroid(pts: Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * footprint를 centroid 기준 수직축(x=c.x)에 대해 좌우반전(Mirror H).
 * 반전은 폴리곤 방향(winding)을 뒤집으므로 점 순서도 뒤집어 CCW를 유지한다 —
 * 그래야 ExtrudeGeometry 면이 뒤집히지 않는다. 일조·사선 계산은 signedArea로
 * winding을 매번 재판별하므로 이 순서 유지는 렌더링만을 위한 것이다.
 */
export function mirrorFootprintH(pts: Point2[]): Point2[] {
  const c = footprintCentroid(pts);
  return pts.map((p) => ({ x: 2 * c.x - p.x, y: p.y })).reverse();
}

/** footprint를 centroid 기준 수평축(y=c.y)에 대해 상하반전(Mirror V). mirrorFootprintH 참고 */
export function mirrorFootprintV(pts: Point2[]): Point2[] {
  const c = footprintCentroid(pts);
  return pts.map((p) => ({ x: p.x, y: 2 * c.y - p.y })).reverse();
}

/**
 * 건물의 footprint와 windowSegments를 **같은 축으로 함께** 반전 (types.ts 불변식).
 * ⚠️ footprint만 반전하면 창면 표시·채광사선·인동거리 창 판정이 전부 반대편 벽으로
 * 어긋난다 — 과거 실제로 있었던 버그. 반전 축은 반전 전 centroid 기준이며,
 * 반사 변환은 centroid를 보존하므로 반전 후에도 동일 축이다.
 */
export function mirrorBuilding(b: Building, axis: "h" | "v"): void {
  const c = footprintCentroid(b.footprint);
  const reflect = (p: Point2): Point2 =>
    axis === "h" ? { x: 2 * c.x - p.x, y: p.y } : { x: p.x, y: 2 * c.y - p.y };
  b.footprint =
    axis === "h" ? mirrorFootprintH(b.footprint) : mirrorFootprintV(b.footprint);
  b.windowSegments = b.windowSegments.map(([a, d]) => [reflect(a), reflect(d)]);
  if (axis === "h") b.mirroredH = !b.mirroredH;
  else b.mirroredV = !b.mirroredV;
}

/** offset(이동·회전)이 반영된 DXF 평면 월드 좌표 footprint */
export function worldFootprint(b: Building): Point2[] {
  const c = footprintCentroid(b.footprint);
  const th = THREE.MathUtils.degToRad(b.offset.rotation);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  return b.footprint.map((p) => {
    const rx = p.x - c.x;
    const ry = p.y - c.y;
    return {
      x: c.x + rx * cos - ry * sin + b.offset.dx,
      y: c.y + rx * sin + ry * cos + b.offset.dy,
    };
  });
}

export function setSelected(group: THREE.Group, selected: boolean): void {
  const mesh = group.getObjectByName("mass") as THREE.Mesh | null;
  if (!mesh) return;
  const mat = mesh.material as THREE.MeshLambertMaterial;
  mat.emissive.setHex(selected ? SELECT_EMISSIVE : 0x000000);
}
