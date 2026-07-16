import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createBuildingObject, mirrorBuilding } from "./buildings";
import { edgeHasWindow } from "./windows";
import type { Building, Point2 } from "./types";

/**
 * 미러 시 footprint와 windowSegments가 함께 반전되는지 — 창면 정합 불변식 회귀 테스트.
 * (과거 버그: footprint만 반전되어 창면 하이라이트·채광사선·인동거리 창 판정이
 * 반대편 벽으로 어긋났음 — 화면상 창면이 주동에서 떨어져 표시되는 증상.)
 */

function mkBuilding(footprint: Point2[]): Building {
  return {
    id: "t-1",
    name: "테스트동",
    type: "계획주동",
    massType: "custom",
    footprint,
    floors: 10,
    floorHeight: 2.8,
    pilotiFloors: 0,
    unitsPerFloor: 4,
    segments: 1,
    unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 },
    analysisTarget: true,
    mirroredH: false,
    mirroredV: false,
    windowSegments: [],
  };
}

/** 모든 windowSegment가 footprint의 어떤 에지와 일치하는지 (정합 불변식) */
function windowsAttached(b: Building): boolean {
  const n = b.footprint.length;
  return b.windowSegments.every(([wa, wb]) => {
    for (let i = 0; i < n; i++) {
      if (edgeHasWindow(b.footprint[i], b.footprint[(i + 1) % n], [[wa, wb]])) return true;
    }
    return false;
  });
}

describe("mirrorBuilding — 창면 정합 불변식", () => {
  // 비대칭 L자 footprint — 반전하면 모양이 실제로 바뀌는 케이스
  const L: Point2[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 6 },
    { x: 8, y: 6 },
    { x: 8, y: 12 },
    { x: 0, y: 12 },
  ];

  it("좌우반전(h) 후에도 창면이 footprint 에지에 붙어 있다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [
      [{ x: 0, y: 0 }, { x: 20, y: 0 }], // 남측 벽
      [{ x: 8, y: 6 }, { x: 8, y: 12 }], // 안쪽 세로 벽
    ];
    expect(windowsAttached(b)).toBe(true);
    mirrorBuilding(b, "h");
    expect(b.mirroredH).toBe(true);
    expect(windowsAttached(b)).toBe(true); // 과거 버그에선 false
  });

  it("상하반전(v) 후에도 창면이 footprint 에지에 붙어 있다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [[{ x: 0, y: 0 }, { x: 20, y: 0 }]];
    mirrorBuilding(b, "v");
    expect(b.mirroredV).toBe(true);
    expect(windowsAttached(b)).toBe(true);
  });

  it("같은 축으로 두 번 반전하면 원상복구된다", () => {
    const b = mkBuilding(L.map((p) => ({ ...p })));
    b.windowSegments = [[{ x: 0, y: 0 }, { x: 20, y: 0 }]];
    mirrorBuilding(b, "h");
    mirrorBuilding(b, "h");
    expect(b.mirroredH).toBe(false);
    // 부동소수점 오차 허용 비교
    expect(b.windowSegments[0][0].x).toBeCloseTo(0, 9);
    expect(b.windowSegments[0][1].x).toBeCloseTo(20, 9);
    expect(windowsAttached(b)).toBe(true);
  });
});

/**
 * 창면 하이라이트 평면이 winding과 무관하게 벽 위·바깥 법선 방향으로 렌더되는지.
 * (과거 버그: CW(미러된 DXF 폴리라인) footprint에서 basis가 왼손좌표(det=-1)가 되어
 * setFromRotationMatrix가 잘못된 회전을 만들었음 — CAD MIRROR는 폴리라인을 CW로
 * 저장하므로, 미러 복사한 동만 창면 판이 벽에서 떨어져 떠다니는 증상이 났다.)
 */
describe("createBuildingObject — 창면 하이라이트 방향 (winding 불변식)", () => {
  /** 창이 있는 10×10 정방형 건물의 하이라이트 평면 월드 법선·중심을 얻는다 */
  function hiliteWorld(footprint: Point2[], win: [Point2, Point2]) {
    const b = mkBuilding(footprint);
    b.windowSegments = [win];
    const group = createBuildingObject(b);
    group.updateMatrixWorld(true);
    const mesh = group.children.find((c) => c.name === "window-hilite") as THREE.Mesh;
    expect(mesh).toBeDefined();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
      mesh.getWorldQuaternion(new THREE.Quaternion()),
    );
    const center = mesh.getWorldPosition(new THREE.Vector3());
    return { normal, center };
  }

  it("CCW footprint — 남측 벽 하이라이트 법선이 남향(three +z)", () => {
    const ccw: Point2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const { normal, center } = hiliteWorld(ccw, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(normal.x).toBeCloseTo(0, 6);
    expect(normal.y).toBeCloseTo(0, 6);
    expect(normal.z).toBeCloseTo(1, 6); // DXF (0,-1) = three +z
    expect(center.x).toBeCloseTo(5, 6); // 벽 중점
    expect(center.z).toBeCloseTo(0.03, 6); // 벽에서 0.03m 바깥
  });

  it("CW(미러) footprint — 서측 벽 하이라이트 법선이 서향(three -x)", () => {
    const cw: Point2[] = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ];
    const { normal, center } = hiliteWorld(cw, [{ x: 0, y: 0 }, { x: 0, y: 10 }]);
    expect(normal.x).toBeCloseTo(-1, 6); // 바깥 법선 (-1,0)
    expect(normal.y).toBeCloseTo(0, 6);
    expect(normal.z).toBeCloseTo(0, 6);
    expect(center.x).toBeCloseTo(-0.03, 6); // 벽(x=0)에서 0.03m 바깥
    expect(center.z).toBeCloseTo(-5, 6); // 벽 중점 (dxf y=5 → three z=-5)
  });
});
