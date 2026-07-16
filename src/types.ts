// plan.md 4장 데이터 모델

export interface Point2 {
  x: number;
  y: number;
}

/** M7 지형 — 등고선 꼭짓점 등 3D 점 (m, DXF 평면 x/y + 고도 z) */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Site {
  latitude: number;
  longitude: number;
  /** 도면 Y+ 기준 정북 보정 각도(도). 0이면 Y+가 정북 */
  northAngle: number;
  /** M6: 대지 면적 (㎡, 수동 입력). 0이면 미입력 — 건폐율·용적률 계산 불가 */
  siteAreaM2: number;
}

export type BuildingType = "계획주동" | "인접건물";

/** M6 주동 타입 — 판상형(slab) | 탑상형(tower) | 분절형(segment) | DXF 원본(custom) */
export type MassType = "slab" | "tower" | "segment" | "custom";

/**
 * M6 전용면적 타입별 층당 세대수 — 사용자가 직접 입력(더 이상 %비율이 아님).
 * 해당 타입의 총 세대수 = countPerFloor × 주거층수(×분절 수) — 층수·필로티가 바뀌면
 * 자동으로 재계산된다(massing.ts의 unitBreakdown/totalUnits가 매번 새로 계산).
 * 평형 추가/삭제로 자유롭게 편집한다.
 */
export interface UnitMixEntry {
  unitType: string;
  countPerFloor: number;
}

export interface BuildingOffset {
  dx: number;
  dy: number;
  /** 평면상 반시계 회전(도) */
  rotation: number;
}

export interface Building {
  id: string;
  name: string;
  type: BuildingType;
  /** M6 주동 타입. DXF에서 불러온 폴리곤은 custom */
  massType: MassType;
  /** DXF에서 추출한 2D 외곽선 (m 단위, 닫힌 폴리곤 — 마지막 점 중복 없음) */
  footprint: Point2[];
  floors: number;
  /** 층고 (m) */
  floorHeight: number;
  /** 필로티 층수 (0~n). 해당 층 하부는 개방 — 그림자를 만들지 않음 */
  pilotiFloors: number;
  /** M6: 층당 세대 수 (분절형은 분절 1개당). 0이면 세대수 산출 제외(인접건물) */
  unitsPerFloor: number;
  /** M6: 분절 수 — 판상형·탑상형·custom은 1 */
  segments: number;
  /** M6: 전용면적 타입별 세대수 (사용자 직접 입력) */
  unitMix: UnitMixEntry[];
  offset: BuildingOffset;
  /** 이 건물의 면을 분석 대상으로 할지 */
  analysisTarget: boolean;
  /** 좌우반전(수평 미러) 적용 여부 — footprint에 이미 반영된 상태를 기록 */
  mirroredH: boolean;
  /** 상하반전(수직 미러) 적용 여부 — footprint에 이미 반영된 상태를 기록 */
  mirroredV: boolean;
  /**
   * PLAN_WIN/ADJ_WIN 레이어에서 매칭된 창면 표시선 — footprint와 동일한 로컬 좌표계
   * (mm→m 변환 후, offset 반영 전). mirror 시 footprint와 함께 반전되어야 정합이 유지된다.
   * 비어 있으면 "창 정보 미지정"으로 간주 — 기존 동작(전체 남향 벽 채광사선 검토)을 유지한다.
   */
  windowSegments: [Point2, Point2][];
}

/** DXF 규약(data/DXF_RULES.md)의 참고용 2D 오버레이 레이어 — 건물 매스로 압출되지 않는다 */
export type OverlayLayer =
  | "SITE_BOUNDARY"
  | "ADJ_BOUNDARY"
  | "ROAD_CL"
  | "PARK_BOUNDARY"
  | "CONTOUR";

export interface OverlayLine {
  layer: OverlayLayer;
  /** DXF 평면 좌표(m) — WCS 공유 전제이므로 건물처럼 offset을 갖지 않는다 */
  points: Point2[];
  closed: boolean;
}

/**
 * 사선·이격 검토 기준값 — 건축법 시행령 제86조가 기본값이며, 조례로 강화·완화될 수
 * 있어 설정값으로 둔다 (plan.md 8장). 프로젝트 JSON에 함께 저장된다.
 */
export interface SetbackRules {
  /**
   * 채광사선(제86조 제3항 제1호): 각 부분 높이 H ≤ 이 값 × (창면에서 직각방향으로
   * 인접대지경계선까지 수평거리 D). 법정 기본 2배 — 근린상업·준주거지역은 4배.
   */
  daylightRatio: number;
  /**
   * 채광사선 — 도로(ROAD_CL)·공원(PARK_BOUNDARY) 기준선에 적용할 배율.
   * 제86조 제3항 제3호는 도로 중심선을 인접대지경계선으로 보아 제1호를 그대로 적용하므로
   * 법정 기본은 daylightRatio와 동일(2배). 조례 대응용으로만 분리해 둔다.
   */
  daylightRoadParkRatio: number;
  /**
   * 인동거리(제86조 제3항 제2호 가목): 채광창 있는 벽면이 마주보는 경우
   * 이격 ≥ 이 값 × 높은 동 높이. 시행령 하한 0.5배 — 서울시 조례는 0.8배.
   */
  spacingRatioWindow: number;
  /** 인동거리(라목): 채광창 없는 벽면과 측벽이 마주보는 경우 최소 이격(m) — 법정 8m */
  spacingNoWindowM: number;
  /** 인동거리(마목): 측벽과 측벽이 마주보는 경우 최소 이격(m) — 법정 4m */
  spacingSideM: number;
  /** 정북사선(제86조 제1항 제1호): 높이 ≤ northSetbackLowHeightM 부분의 최소 이격(m) — 법정 1.5m */
  northSetbackLowM: number;
  /** 정북사선 저층부 기준 높이(m) — 법정 10m */
  northSetbackLowHeightM: number;
  /** 정북사선(제2호): 기준 높이 초과 부분은 이격 ≥ 이 값 × 각 부분 높이 — 법정 0.5 */
  northSetbackRatio: number;
}

/**
 * 프리셋: 건축법 시행령 제86조 법정 기본값.
 * 정북 1.5m/10m/0.5, 채광 2배(도로·공원도 2배), 인동 0.5배/8m/4m.
 */
export function statutorySetbackRules(): SetbackRules {
  return {
    daylightRatio: 2.0,
    daylightRoadParkRatio: 2.0,
    spacingRatioWindow: 0.5,
    spacingNoWindowM: 8,
    spacingSideM: 4,
    northSetbackLowM: 1.5,
    northSetbackLowHeightM: 10,
    northSetbackRatio: 0.5,
  };
}

/**
 * 프리셋: 서울특별시 건축조례 제60조 — 채광창 있는 벽면이 마주보는 인동거리만
 * 0.8배로 강화(그 밖의 항목은 시행령과 동일). 남측 저층+개구부 남향 특례(0.6/0.8배),
 * 도시형생활주택 0.25배 등 세부 특례는 미반영 — 필요 시 값을 직접 수정.
 */
export function seoulSetbackRules(): SetbackRules {
  return { ...statutorySetbackRules(), spacingRatioWindow: 0.8 };
}

/** 일조권(수인한도) 판정 기준 — 대법원 판례상 09~15시 연속 2h 또는 08~16시 총 4h */
export type SunHoursRule = "either" | "continuous" | "total";

/** 일조권 검토(인접건물, 레이캐스팅 기반) 설정 */
export interface SunHoursSettings {
  /** 태양 위치 샘플 간격 (분) */
  timeStep: number;
  rule: SunHoursRule;
}

export interface AnalysisSettings {
  /** PV(M4/M5)·일조권 검토 공용 격자 간격 (m) */
  gridSize: number;
  /** 기준일 — PV 대표일(연도)·그림자 미리보기·일조권 검토에 쓰임 "YYYY-MM-DD" */
  date: string;
  setbackRules: SetbackRules;
  sunHours: SunHoursSettings;
}

export interface Project {
  site: Site;
  /** 현재 장면(3D 뷰·분석 대상)에 배치된 건물 — buildingLibrary에서 골라 인스턴스화된 것들 */
  buildings: Building[];
  analysis: AnalysisSettings;
  /** DXF SITE_BOUNDARY/ADJ_BOUNDARY/ROAD_CL/PARK_BOUNDARY/CONTOUR 참고용 오버레이 선 */
  siteOverlays: OverlayLine[];
  /**
   * DXF에서 불러온 계획주동(PLAN_BLDG) 템플릿 전체 — 장면 포함 여부와 무관하게 누적된다.
   * 사용자가 체크박스로 골라 "장면에 추가"하면 buildings에 복제되어 들어간다.
   * 인접건물(ADJ_BLDG)은 라이브러리를 거치지 않고 로드 즉시 buildings에 추가된다.
   */
  buildingLibrary: Building[];
}

export function buildingHeight(b: Building): number {
  return b.floors * b.floorHeight;
}

/** 미러 상태 표기 — 엑셀 배치개요 "미러" 컬럼, 건물 카드 표시에 공용 */
export function mirrorLabel(b: Building): string {
  if (b.mirroredH && b.mirroredV) return "수평+수직";
  if (b.mirroredH) return "수평";
  if (b.mirroredV) return "수직";
  return "없음";
}

export function defaultProject(): Project {
  return {
    // 기본값: 서울
    site: { latitude: 37.57, longitude: 126.98, northAngle: 0, siteAreaM2: 0 },
    buildings: [],
    siteOverlays: [],
    buildingLibrary: [],
    analysis: {
      gridSize: 1.0,
      date: "2026-12-21",
      setbackRules: statutorySetbackRules(),
      sunHours: {
        timeStep: 10,
        rule: "either",
      },
    },
  };
}
