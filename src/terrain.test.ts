import { describe, expect, it } from "vitest";
import { parseDxfBuildings } from "./dxf";
import {
  buildTerrainModel,
  clipTriangles,
  contourSuffixElevation,
  isContourLayer,
  nearestPointElevation,
  sampleElevation,
  terrainElevationForFootprint,
} from "./terrain";
import type { Point3 } from "./types";

/**
 * terrain.ts M7 지형 검증 (PLAN.md "단계별 검증 방법" M7 항목).
 * 1부: CONTOUR 파싱 — Z좌표 우선, LWPOLYLINE elevation(38), 레이어 접미사 폴백, 단위 변환.
 * 2부: TIN — 등고선 위 보간고도 = 등고선 표고, 단일 경사면 경사각, 대지경계 클리핑.
 */

function dxfText(opts: { header?: string; entities: string }): string {
  const headerSection = opts.header
    ? `0\nSECTION\n2\nHEADER\n${opts.header}0\nENDSEC\n`
    : "";
  return `${headerSection}0\nSECTION\n2\nENTITIES\n${opts.entities}0\nENDSEC\n0\nEOF\n`;
}

/** 3D 꼭짓점을 가진 POLYLINE(+VERTEX/SEQEND) — 등고선 표준 형태 */
function polyline3dEntity(layer: string, pts: [number, number, number][]): string {
  let s = `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n8\n`;
  for (const [x, y, z] of pts) {
    s += `0\nVERTEX\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n${z}\n`;
  }
  return s + "0\nSEQEND\n";
}

/** elevation(그룹코드 38)을 가진 LWPOLYLINE — 버텍스에는 z가 없음 */
function lwpolylineElevEntity(
  layer: string,
  elevation: number,
  pts: [number, number][],
): string {
  let s = `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n0\n38\n${elevation}\n`;
  for (const [x, y] of pts) s += `10\n${x}\n20\n${y}\n`;
  return s;
}

function lineEntity(
  layer: string,
  a: [number, number, number],
  b: [number, number, number],
): string {
  return (
    `0\nLINE\n8\n${layer}\n10\n${a[0]}\n20\n${a[1]}\n30\n${a[2]}\n` +
    `11\n${b[0]}\n21\n${b[1]}\n31\n${b[2]}\n`
  );
}

describe("CONTOUR 레이어명 매칭", () => {
  it("CONTOUR / CONTOUR_10 / CONTOUR_25.5 / CONTOUR_-3 인식", () => {
    expect(isContourLayer("CONTOUR")).toBe(true);
    expect(isContourLayer("CONTOUR_10")).toBe(true);
    expect(isContourLayer("CONTOUR_25.5")).toBe(true);
    expect(isContourLayer("CONTOUR_-3")).toBe(true);
    expect(isContourLayer("CONTOURS")).toBe(false);
    expect(isContourLayer("SITE_BOUNDARY")).toBe(false);
  });

  it("접미사 고도(m) 파싱 — 없으면 null", () => {
    expect(contourSuffixElevation("CONTOUR_10")).toBe(10);
    expect(contourSuffixElevation("CONTOUR_25.5")).toBe(25.5);
    expect(contourSuffixElevation("CONTOUR_-3")).toBe(-3);
    expect(contourSuffixElevation("CONTOUR")).toBeNull();
  });
});

describe("CONTOUR 파싱 — parseDxfBuildings 통합", () => {
  it("3D POLYLINE 꼭짓점 Z를 고도로 사용 (mm → m 변환)", () => {
    const text = dxfText({
      header: "9\n$INSUNITS\n70\n4\n",
      entities: polyline3dEntity("CONTOUR", [
        [0, 0, 5000],
        [10000, 0, 5000],
        [20000, 0, 5000],
      ]),
    });
    const r = parseDxfBuildings(text, "auto");
    expect(r.contourPoints).toHaveLength(3);
    expect(r.contourPoints[0]).toEqual({ x: 0, y: 0, z: 5 });
    expect(r.contourPoints[1]).toEqual({ x: 10, y: 0, z: 5 });
  });

  it("LWPOLYLINE elevation(그룹코드 38)을 전체 꼭짓점 고도로 사용", () => {
    const text = dxfText({
      entities: lwpolylineElevEntity("CONTOUR", 10000, [
        [0, 0],
        [50000, 0],
      ]),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.contourPoints).toHaveLength(2);
    expect(r.contourPoints[0].z).toBeCloseTo(10);
    expect(r.contourPoints[1].x).toBeCloseTo(50);
  });

  it("Z=0이면 레이어 접미사 고도(m, 단위 변환 없음) 폴백", () => {
    const text = dxfText({
      entities:
        lwpolylineElevEntity("CONTOUR_10", 0, [
          [0, 0],
          [50000, 0],
        ]) +
        lwpolylineElevEntity("CONTOUR_25.5", 0, [
          [0, 10000],
          [50000, 10000],
        ]),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.contourPoints).toHaveLength(4);
    expect(r.contourPoints[0].z).toBe(10);
    expect(r.contourPoints[2].z).toBe(25.5);
  });

  it("Z값이 있으면 레이어 접미사보다 우선", () => {
    const text = dxfText({
      entities: polyline3dEntity("CONTOUR_10", [
        [0, 0, 7000],
        [50000, 0, 7000],
      ]),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.contourPoints[0].z).toBeCloseTo(7);
  });

  it("LINE 엔티티도 CONTOUR로 인식", () => {
    const text = dxfText({
      entities: lineEntity("CONTOUR_5", [0, 0, 0], [50000, 0, 0]),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.contourPoints).toHaveLength(2);
    expect(r.contourPoints[0].z).toBe(5);
  });

  it("CONTOUR는 참고선 오버레이(2D)로도 등록된다", () => {
    const text = dxfText({
      entities: polyline3dEntity("CONTOUR", [
        [0, 0, 5000],
        [10000, 0, 5000],
      ]),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.overlays).toHaveLength(1);
    expect(r.overlays[0].layer).toBe("CONTOUR");
    expect(r.overlays[0].points[1]).toEqual({ x: 10, y: 0 });
  });

  it("CONTOUR 전용 파일도 허용 — 건물 없어도 파싱 성공", () => {
    const text = dxfText({
      entities: polyline3dEntity("CONTOUR", [
        [0, 0, 5000],
        [10000, 0, 5000],
      ]),
    });
    expect(() => parseDxfBuildings(text, "mm")).not.toThrow();
  });

  it("CONTOUR 없는 파일은 contourPoints 빈 배열 (평지 모드 유지)", () => {
    const text = dxfText({
      entities:
        `0\nLWPOLYLINE\n8\nPLAN_A_1\n90\n4\n70\n1\n` +
        `10\n0\n20\n0\n10\n10000\n20\n0\n10\n10000\n20\n10000\n10\n0\n20\n10000\n`,
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.contourPoints).toEqual([]);
  });
});

// ---------- 2부: TIN 생성 · 고도 샘플링 ----------

/** 등고선 평행·등간격 단일 경사면 — y=0→z0m, y=20→z10m, … (경사 dz/dy = 0.5) */
function slopeContours(): Point3[] {
  const pts: Point3[] = [];
  for (let row = 0; row <= 5; row++) {
    const y = row * 20;
    const z = row * 10;
    for (let x = 0; x <= 100; x += 20) pts.push({ x, y, z });
  }
  return pts;
}

describe("buildTerrainModel", () => {
  it("점 3개 미만 또는 전부 일직선이면 null (평지 모드 유지)", () => {
    expect(buildTerrainModel([])).toBeNull();
    expect(
      buildTerrainModel([
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 5 },
      ]),
    ).toBeNull();
    expect(
      buildTerrainModel([
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 5 },
        { x: 20, y: 0, z: 10 },
      ]),
    ).toBeNull(); // 일직선 — 삼각형 0개
  });

  it("중복 점(1cm 격자)은 제거하고 삼각분할", () => {
    const m = buildTerrainModel([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0.001, z: 99 }, // 사실상 같은 위치 — 제거
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 10 },
    ]);
    expect(m).not.toBeNull();
    expect(m!.points).toHaveLength(3);
  });

  it("고도 범위(minZ·maxZ) 집계", () => {
    const m = buildTerrainModel(slopeContours())!;
    expect(m.minZ).toBe(0);
    expect(m.maxZ).toBe(50);
  });
});

describe("sampleElevation — 단일 경사면 검증", () => {
  const model = buildTerrainModel(slopeContours())!;

  it("등고선 위의 점은 등고선 표고 그대로", () => {
    expect(sampleElevation(model, 50, 0)).toBeCloseTo(0);
    expect(sampleElevation(model, 30, 20)).toBeCloseTo(10);
    expect(sampleElevation(model, 70, 100)).toBeCloseTo(50);
  });

  it("등고선 사이는 선형 보간 — 경사 dz/dy = 0.5 일치", () => {
    expect(sampleElevation(model, 50, 10)).toBeCloseTo(5);
    expect(sampleElevation(model, 50, 30)).toBeCloseTo(15);
    expect(sampleElevation(model, 13, 55)).toBeCloseTo(27.5);
  });

  it("TIN 외곽(hull) 밖은 null, 최근접 폴백은 근처 표고", () => {
    expect(sampleElevation(model, 50, -30)).toBeNull();
    expect(nearestPointElevation(model, 50, -30)).toBeCloseTo(0);
    expect(nearestPointElevation(model, 50, 130)).toBeCloseTo(50);
  });
});

describe("terrainElevationForFootprint — 건물 G.L.", () => {
  const model = buildTerrainModel(slopeContours())!;

  it("경사면 위 사각형 footprint → 꼭짓점 고도 평균", () => {
    // y=20(z=10)과 y=40(z=20) 사이 사각형 → 평균 (10+10+20+20)/4 = 15
    const gl = terrainElevationForFootprint(model, [
      { x: 30, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 40 },
      { x: 30, y: 40 },
    ]);
    expect(gl).toBeCloseTo(15);
  });

  it("평평한 구간의 건물은 그 표고 그대로 (파묻힘·뜸 없음)", () => {
    const gl = terrainElevationForFootprint(model, [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ]);
    expect(gl).toBeCloseTo(10);
  });

  it("hull 밖으로 드래그해도 최근접 표고로 폴백 — 0으로 튀지 않음", () => {
    const gl = terrainElevationForFootprint(model, [
      { x: 50, y: 110 },
      { x: 60, y: 115 },
    ]);
    expect(gl).toBeCloseTo(50);
  });
});

describe("clipTriangles — 대지경계 클리핑", () => {
  const model = buildTerrainModel(slopeContours())!;

  it("경계 없으면 전체 삼각형 유지", () => {
    expect(clipTriangles(model, null)).toHaveLength(model.triangles.length);
  });

  it("대지경계 안 무게중심 삼각형만 남는다", () => {
    const site = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 0, y: 40 },
    ];
    const clipped = clipTriangles(model, site);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThan(model.triangles.length);
    // 남은 삼각형 무게중심은 전부 y ≤ 40 근방
    for (let i = 0; i < clipped.length; i += 3) {
      const cy =
        (model.points[clipped[i]].y +
          model.points[clipped[i + 1]].y +
          model.points[clipped[i + 2]].y) /
        3;
      expect(cy).toBeLessThan(40);
    }
  });
});
