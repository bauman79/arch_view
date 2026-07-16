import { describe, expect, it } from "vitest";
import { parseDxfBuildings } from "./dxf";
import { contourSuffixElevation, isContourLayer } from "./terrain";

/**
 * terrain.ts M7 지형 검증 (PLAN.md "단계별 검증 방법" M7 항목).
 * 1부: CONTOUR 파싱 — Z좌표 우선, LWPOLYLINE elevation(38), 레이어 접미사 폴백, 단위 변환.
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
