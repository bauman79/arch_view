import type { Building, OverlayLine, Point2, Point3, Project } from "./types";

/**
 * .view 파일 — 작업 중인 프로젝트 전체(장면·라이브러리·오버레이·분석 설정)를
 * JSON으로 저장/복원한다. DXF와 달리 층수·평형 구성·offset·라이브러리까지
 * 그대로 보존되는 arch_view 전용 세션 파일.
 */

export const VIEW_FORMAT = "arch_view";
export const VIEW_VERSION = 1;

export interface ViewFileData {
  format: typeof VIEW_FORMAT;
  version: number;
  savedAt: string;
  /** DXF 원점 보정값(m) — 이후 "DXF 추가" 병합·DXF 내보내기 좌표 복원에 필요 */
  sceneOrigin: Point2 | null;
  /** id 발급 카운터 — 복원 후 새로 추가되는 건물과 id가 충돌하지 않게 이어서 쓴다 */
  counters: { dxfLoadSeq: number; sceneSeq: number };
  site: Project["site"];
  analysis: Project["analysis"];
  buildings: Building[];
  buildingLibrary: Building[];
  siteOverlays: OverlayLine[];
  /** M7 지형 등고선 점 — v1 파일에는 없음(복원 시 빈 배열 = 평지) */
  terrainPoints: Point3[];
}

export function serializeView(
  project: Project,
  sceneOrigin: Point2 | null,
  counters: { dxfLoadSeq: number; sceneSeq: number },
): string {
  const data: ViewFileData = {
    format: VIEW_FORMAT,
    version: VIEW_VERSION,
    savedAt: new Date().toISOString(),
    sceneOrigin,
    counters,
    site: project.site,
    analysis: project.analysis,
    buildings: project.buildings,
    buildingLibrary: project.buildingLibrary,
    siteOverlays: project.siteOverlays,
    terrainPoints: project.terrainPoints,
  };
  return JSON.stringify(data, null, 1);
}

/** 파싱 + 구조 검증. 형식이 아니면 한국어 메시지로 throw */
export function deserializeView(text: string): ViewFileData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(".view 파일이 아닙니다 (JSON 파싱 실패)");
  }
  const d = raw as Partial<ViewFileData>;
  if (d?.format !== VIEW_FORMAT) {
    throw new Error(".view 파일이 아닙니다 (format 표식 없음)");
  }
  if (typeof d.version !== "number" || d.version > VIEW_VERSION) {
    throw new Error(
      `지원하지 않는 .view 버전(${d.version})입니다 — 프로그램을 업데이트하세요`,
    );
  }
  if (!Array.isArray(d.buildings) || !Array.isArray(d.buildingLibrary)) {
    throw new Error(".view 파일이 손상됐습니다 (건물 목록 없음)");
  }
  if (!d.site || !d.analysis) {
    throw new Error(".view 파일이 손상됐습니다 (설정 없음)");
  }
  // 건물 필수 필드 최소 검증 — footprint 없는 건물이 섞이면 렌더에서 터진다
  for (const b of [...d.buildings, ...d.buildingLibrary]) {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3) {
      throw new Error(`.view 파일이 손상됐습니다 (건물 "${b.name ?? "?"}" footprint 이상)`);
    }
    if (!Array.isArray(b.windowSegments)) b.windowSegments = [];
  }
  return {
    format: VIEW_FORMAT,
    version: d.version,
    savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    sceneOrigin: d.sceneOrigin ?? null,
    counters: {
      dxfLoadSeq: d.counters?.dxfLoadSeq ?? 0,
      sceneSeq: d.counters?.sceneSeq ?? 0,
    },
    site: d.site,
    analysis: d.analysis,
    buildings: d.buildings,
    buildingLibrary: d.buildingLibrary,
    siteOverlays: Array.isArray(d.siteOverlays) ? d.siteOverlays : [],
    terrainPoints: Array.isArray(d.terrainPoints) ? d.terrainPoints : [],
  };
}
