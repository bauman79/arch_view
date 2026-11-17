import { defaultProject, type Building, type Point2, type Project } from "./types";

/** 테스트 공용 — 사각형 footprint */
export function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export function mkBuilding(
  id: string,
  type: "계획주동" | "인접건물",
  fp: Point2[],
  floors: number,
  extra: Partial<Building> = {},
): Building {
  return {
    id, name: id, type, massType: "custom", footprint: fp, floors, floorHeight: 3,
    pilotiFloors: 0, unitsPerFloor: 0, segments: 1, unitMix: [],
    offset: { dx: 0, dy: 0, rotation: 0 }, analysisTarget: type === "계획주동",
    mirroredH: false, mirroredV: false, windowSegments: [],
    ...extra,
  };
}

export function mkProject(bs: Building[]): Project {
  const p = defaultProject();
  p.buildings = bs;
  p.analysis.date = "2026-12-21";
  return p;
}
