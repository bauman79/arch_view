import { describe, expect, it } from "vitest";
import { signedArea } from "./geom2d";
import { letterSeq, parseDxfBuildings, parseFloorText } from "./dxf";

/**
 * dxf.ts 파싱 검증 — 단위 자동감지($INSUNITS), 레이어 접미사 층수 파싱,
 * PLAN_WIN/ADJ_WIN 창면 매칭(허용오차 0.1m), 오버레이 전용 파일 허용.
 */

function dxfText(opts: {
  header?: string;
  entities: string;
}): string {
  const headerSection = opts.header
    ? `0\nSECTION\n2\nHEADER\n${opts.header}0\nENDSEC\n`
    : "";
  return `${headerSection}0\nSECTION\n2\nENTITIES\n${opts.entities}0\nENDSEC\n0\nEOF\n`;
}

function rectEntity(layer: string, x0: number, y0: number, x1: number, y1: number): string {
  return (
    `0\nLWPOLYLINE\n8\n${layer}\n90\n4\n70\n1\n` +
    `10\n${x0}\n20\n${y0}\n10\n${x1}\n20\n${y0}\n10\n${x1}\n20\n${y1}\n10\n${x0}\n20\n${y1}\n`
  );
}

function lineEntity(layer: string, x0: number, y0: number, x1: number, y1: number): string {
  return `0\nLINE\n8\n${layer}\n10\n${x0}\n20\n${y0}\n30\n0\n11\n${x1}\n21\n${y1}\n31\n0\n`;
}

describe("단위 자동감지", () => {
  it("$INSUNITS=4 → mm로 인식해 /1000", () => {
    const text = dxfText({
      header: "9\n$INSUNITS\n70\n4\n",
      entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000),
    });
    const r = parseDxfBuildings(text, "auto");
    expect(r.unitScale).toBeCloseTo(0.001);
    expect(r.unitSource).toBe("header-mm");
    expect(r.buildings[0].footprint[1].x).toBeCloseTo(55);
  });

  it("$INSUNITS=6 → m로 인식해 그대로", () => {
    const text = dxfText({
      header: "9\n$INSUNITS\n70\n6\n",
      entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55, 12),
    });
    const r = parseDxfBuildings(text, "auto");
    expect(r.unitScale).toBe(1);
    expect(r.unitSource).toBe("header-m");
    expect(r.buildings[0].footprint[1].x).toBeCloseTo(55);
  });

  it("HEADER 없으면 mm 기본값 적용", () => {
    const text = dxfText({ entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) });
    const r = parseDxfBuildings(text, "auto");
    expect(r.unitSource).toBe("default-mm");
    expect(r.buildings[0].footprint[1].x).toBeCloseTo(55);
  });

  it("수동 모드가 $INSUNITS보다 우선", () => {
    const text = dxfText({
      header: "9\n$INSUNITS\n70\n4\n",
      entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55, 12),
    });
    const r = parseDxfBuildings(text, "m");
    expect(r.unitSource).toBe("manual-m");
    expect(r.buildings[0].footprint[1].x).toBeCloseTo(55);
  });
});

describe("레이어 접미사 층수", () => {
  it("PLAN_BLDG_15F → 15층, 접미사 없으면 기본 1층", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 10000, 10000) +
        rectEntity("PLAN_BLDG", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].floors).toBe(15);
    expect(r.buildings[1].floors).toBe(1); // 층수 정보 없음 → 1개층으로 불러와 직접 입력
  });

  it("ADJ_BLDG_5F → 5층 (대소문자 무관)", () => {
    const text = dxfText({ entities: rectEntity("adj_bldg_5f", 0, 0, 10000, 10000) });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].floors).toBe(5);
    expect(r.buildings[0].type).toBe("인접건물");
  });
});

describe("PLAN_<타입>_<번호> 권장 규약", () => {
  it("PLAN_A_1 → 계획주동_A_1, 기본 1층", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_B_2", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].name).toBe("계획주동_A_1");
    expect(r.buildings[0].type).toBe("계획주동");
    expect(r.buildings[0].floors).toBe(1); // 접미사 없음 → 기본 1층
    expect(r.buildings[1].name).toBe("계획주동_B_2");
  });

  it("층수 접미사도 함께 쓸 수 있다 — PLAN_A_3_20F → 20층", () => {
    const text = dxfText({ entities: rectEntity("plan_a_3_20f", 0, 0, 10000, 10000) });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].name).toBe("계획주동_A_3");
    expect(r.buildings[0].floors).toBe(20);
  });

  it("ADJ_<타입>_<번호>도 지원 — ADJ_C_1 → 인접건물_C_1, 기본 1층", () => {
    const text = dxfText({ entities: rectEntity("ADJ_C_1", 0, 0, 10000, 10000) });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].name).toBe("인접건물_C_1");
    expect(r.buildings[0].type).toBe("인접건물");
    expect(r.buildings[0].floors).toBe(1);
  });

  it("같은 레이어에 폴리라인이 여러 개면 -2, -3으로 구분", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].name).toBe("계획주동_A_1");
    expect(r.buildings[1].name).toBe("계획주동_A_1-2");
  });

  it("구버전 PLAN_BLDG_15F 규약과 섞여 있어도 둘 다 인식", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_BLDG_12F", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(2);
    expect(r.buildings[0].name).toBe("계획주동_A_1");
    expect(r.buildings[1].floors).toBe(12);
  });
});

/**
 * 타입 레이어(PLAN_A_1 등)는 "같은 타입 주동"을 뜻하므로 형상이 모두 합동이어야 한다.
 * 섞여 있으면 이름(…-5, …-6)만으로 구분이 안 돼 "복사·미러본"으로 오인하기 쉬워 안내한다.
 * 판정에는 영향이 없으므로 경고만 — 건물은 그대로 다 불러온다.
 */
describe("한 타입 레이어에 다른 형상 혼재 감지", () => {
  /** 임의 꼭짓점 폴리라인 (닫힘) */
  function polyEntity(layer: string, pts: [number, number][]): string {
    const head = `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n1\n`;
    return head + pts.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("");
  }
  // 비대칭 L자 — 미러하면 좌표는 달라지지만 형상은 합동
  const L: [number, number][] = [
    [0, 0],
    [20000, 0],
    [20000, 6000],
    [8000, 6000],
    [8000, 15000],
    [0, 15000],
  ];
  // 원점 기준으로만 미러하면 x=0 변이 원본과 맞닿아 "벽을 맞댄 한 동"으로 합쳐진다.
  // 이 describe의 관심사는 형상(미러) 판정이므로 떨어뜨려 둔다 — 맞닿은 경우의 동작은
  // 아래 "벽을 맞댄 폴리곤 병합"에서 따로 검증한다.
  const mirroredL = L.map(([x, y]) => [-x - 30000, y] as [number, number]);

  it("합동인 형상만 있으면 경고 없음", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings.filter((w) => w.includes("다른 형상"))).toHaveLength(0);
  });

  it("미러 복사본은 같은 타입으로 보아 경고 없음", () => {
    const text = dxfText({
      entities: polyEntity("PLAN_A_1", L) + polyEntity("PLAN_A_1", mirroredL),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(2);
    expect(r.warnings.filter((w) => w.includes("다른 형상"))).toHaveLength(0);
  });

  it("형상이 다르면 경고하고, 어긋난 동 이름을 짚어준다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 20000, 20000) + // 400㎡
        rectEntity("PLAN_A_1", 40000, 0, 60000, 20000) + // 400㎡ (합동)
        rectEntity("PLAN_A_1", 80000, 0, 90000, 10000), // 100㎡ (다름)
    });
    const r = parseDxfBuildings(text, "mm");
    const w = r.warnings.find((x) => x.includes("다른 형상"));
    expect(w).toBeDefined();
    expect(w).toContain("PLAN_A_1");
    expect(w).toContain("서로 다른 형상 2종");
    expect(w).toContain("계획주동_A_1-3"); // 어긋난 1동만 이름 표기
    expect(r.buildings).toHaveLength(3); // 경고일 뿐 — 전부 정상 로드
  });

  it("타입 구분이 없는 구버전 PLAN_BLDG는 형상이 달라도 경고하지 않는다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 20000, 20000) +
        rectEntity("PLAN_BLDG_15F", 40000, 0, 50000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings.filter((w) => w.includes("다른 형상"))).toHaveLength(0);
  });
});

describe("사이트 오버레이 전용 파일 허용", () => {
  it("건물 레이어 없이 SITE_BOUNDARY만 있어도 에러 없이 로드된다", () => {
    const text = dxfText({
      entities: rectEntity("SITE_BOUNDARY", 0, 0, 100000, 80000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(0);
    expect(r.overlays).toHaveLength(1);
    expect(r.overlays[0].layer).toBe("SITE_BOUNDARY");
  });

  it("알려진 레이어가 전혀 없으면 에러", () => {
    const text = dxfText({ entities: rectEntity("UNKNOWN_LAYER", 0, 0, 1000, 1000) });
    expect(() => parseDxfBuildings(text, "mm")).toThrow();
  });
});

describe("PLAN_WIN/ADJ_WIN 창면 매칭", () => {
  it("footprint 에지와 같은 좌표의 PLAN_WIN이 해당 건물에 매칭된다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) +
        lineEntity("PLAN_WIN", 0, 0, 55000, 0), // 남측 벽(0,0)-(55,0)m
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].windowSegments).toHaveLength(1);
    expect(r.buildings[0].windowSegments[0][0].x).toBeCloseTo(0);
    expect(r.buildings[0].windowSegments[0][1].x).toBeCloseTo(55);
    expect(r.warnings).toHaveLength(0);
  });

  it("여러 건물이 있을 때 각 PLAN_WIN이 올바른 건물에만 매칭되고 오탐 경고가 없다 (회귀)", () => {
    // 버그였던 사례: 건물 기준으로 순회하면 "다른 건물에 이미 매칭된 선분"을
    // 미매칭으로 잘못 세어 불필요한 경고가 발생했다.
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) +
        rectEntity("PLAN_BLDG_15F", 0, 20000, 55000, 32000) +
        rectEntity("PLAN_BLDG_10F", 100000, 0, 115000, 15000) +
        lineEntity("PLAN_WIN", 0, 0, 55000, 0) + // 1동 남측
        lineEntity("PLAN_WIN", 0, 20000, 55000, 20000), // 2동 남측
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings).toHaveLength(0);
    expect(r.buildings[0].windowSegments).toHaveLength(1);
    expect(r.buildings[1].windowSegments).toHaveLength(1);
    expect(r.buildings[2].windowSegments).toHaveLength(0);
  });

  it("LWPOLYLINE로 그린 PLAN_WIN도 매칭된다 — AC1027+ vertex ID(코드 91) 포함 (회귀)", () => {
    // 버그였던 사례: dxf-parser 내장 LWPOLYLINE 파서는 버텍스 목록에서 모르는
    // 그룹코드(91)를 만나면 파싱을 중단해 첫 버텍스만 남았다 — AutoCAD 2013+ 형식
    // 도면의 PLAN_WIN이 경고 없이 조용히 무시됐다.
    const win =
      `0\nLWPOLYLINE\n8\nPLAN_WIN\n90\n2\n70\n0\n` +
      `10\n0\n20\n0\n91\n1\n10\n55000\n20\n0\n91\n2\n`;
    const text = dxfText({
      entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) + win,
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings).toHaveLength(0);
    expect(r.buildings[0].windowSegments).toHaveLength(1);
    expect(r.buildings[0].windowSegments[0][1].x).toBeCloseTo(55);
  });

  it("closed LWPOLYLINE PLAN_WIN은 마지막→첫 버텍스 에지도 창면에 포함 (회귀)", () => {
    // footprint 전체 외곽을 closed 폴리라인으로 창면 표시하면 4개 벽 모두 매칭돼야 한다
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) +
        rectEntity("PLAN_WIN", 0, 0, 55000, 12000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings).toHaveLength(0);
    expect(r.buildings[0].windowSegments).toHaveLength(4);
  });

  it("미러된 엔티티(extrusion 0,0,-1)는 OCS x부호를 반전해 매칭 (회귀)", () => {
    // AutoCAD MIRROR는 좌표 대신 extrusion 벡터를 (0,0,-1)로 뒤집어 저장하기도
    // 한다 — 저장된 x는 부호 반전된 OCS 값이므로 그대로 쓰면 footprint와 어긋난다.
    const mirroredWin =
      `0\nLWPOLYLINE\n8\nPLAN_WIN\n90\n2\n70\n0\n` +
      `10\n0\n20\n0\n10\n-55000\n20\n0\n` + // WCS (0,0)-(55000,0)의 OCS 표현
      `210\n0\n220\n0\n230\n-1\n`;
    const text = dxfText({
      entities: rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) + mirroredWin,
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.warnings).toHaveLength(0);
    expect(r.buildings[0].windowSegments).toHaveLength(1);
  });

  it("미러된 건물 footprint도 extrusion 반영해 WCS 좌표로 복원", () => {
    const mirroredBldg =
      `0\nLWPOLYLINE\n8\nPLAN_BLDG_15F\n90\n4\n70\n1\n` +
      `10\n0\n20\n0\n10\n-55000\n20\n0\n10\n-55000\n20\n12000\n10\n0\n20\n12000\n` +
      `210\n0\n220\n0\n230\n-1\n`;
    const text = dxfText({ entities: mirroredBldg });
    const r = parseDxfBuildings(text, "mm");
    const xs = r.buildings[0].footprint.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(55);
  });

  it("어떤 건물 에지와도 일치하지 않으면 경고 후 무시", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_BLDG_15F", 0, 0, 55000, 12000) +
        lineEntity("PLAN_WIN", 0, 5000, 55000, 5000), // 건물 안쪽 — 에지와 불일치
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].windowSegments).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("PLAN_WIN"))).toBe(true);
  });
});

/**
 * 세대 유니트·코어를 따로 그린 동평면을 한 동으로 합치는 동작.
 * 판별 기준은 레이어가 아니라 **엣지 공유**다 — 떨어진 폴리곤은 기존대로 여러 동으로 남는다.
 */
describe("벽을 맞댄 폴리곤 병합", () => {
  it("벽을 맞댄 유니트 2개는 한 동으로 합쳐진다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 10000, 0, 20000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(1);
    const xs = r.buildings[0].footprint.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6); // 20m 한 덩어리
    expect(r.warnings.some((w) => w.includes("합쳤습니다"))).toBe(true);
  });

  it("유니트 3개 + 코어가 붙은 동평면 → 1동 (면적 보존)", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 10000, 0, 20000, 10000) +
        rectEntity("PLAN_A_1", 20000, 0, 30000, 10000) +
        rectEntity("PLAN_A_1", 10000, 10000, 20000, 16000), // 코어(위에 붙음)
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(1);
    expect(Math.abs(signedArea(r.buildings[0].footprint))).toBeCloseTo(360, 6);
  });

  it("떨어진 폴리곤은 합치지 않는다 — 여러 동 배치 규약 유지 (회귀)", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 20000, 0, 30000, 10000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes("합쳤습니다"))).toBe(false);
  });

  it("맞댄 덩어리와 떨어진 동이 섞여 있어도 각각 처리된다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 10000, 0, 20000, 10000) + // 위와 맞닿음
        rectEntity("PLAN_A_1", 50000, 0, 60000, 10000), // 별개 동
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(2);
  });

  it("합쳐진 외곽선 위의 PLAN_WIN이 그대로 창면으로 매칭된다", () => {
    // 두 유니트가 맞닿아 20m 동이 되고, 남측 외벽 전체에 창면 표시
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 10000, 0, 20000, 10000) +
        lineEntity("PLAN_WIN", 0, 0, 10000, 0) +
        lineEntity("PLAN_WIN", 10000, 0, 20000, 0),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(1);
    expect(r.buildings[0].windowSegments).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes("어떤 건물 외곽선 위에도"))).toBe(false);
  });

  it("서로 다른 타입은 레이어로 나누면 각각 1동이 된다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        rectEntity("PLAN_A_1", 10000, 0, 20000, 10000) +
        rectEntity("PLAN_B_1", 40000, 0, 50000, 12000) +
        rectEntity("PLAN_B_1", 50000, 0, 60000, 12000),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings).toHaveLength(2);
    expect(r.buildings.map((b) => b.name).sort()).toEqual([
      "계획주동_A_1",
      "계획주동_B_1",
    ]);
  });
});

/**
 * 건물 외곽선 안의 층수 문자 — 배치도를 통째로 불러온 뒤 동마다 층수를 따로 적어 두는 흐름.
 */
describe("층수 문자", () => {
  function textEntity(layer: string, x: number, y: number, s: string, centered = false): string {
    // centered: 정렬 지정(72/73) + 두 번째 정렬점(11/21) — CAD에서 가운데 맞춤한 문자
    return centered
      ? `0\nTEXT\n8\n${layer}\n10\n0\n20\n0\n30\n0\n40\n500\n1\n${s}\n72\n1\n11\n${x}\n21\n${y}\n31\n0\n73\n2\n`
      : `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n500\n1\n${s}\n`;
  }
  function mtextEntity(layer: string, x: number, y: number, s: string): string {
    return `0\nMTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n500\n1\n${s}\n`;
  }

  it("parseFloorText — 5F·5층·5·서식 코드를 읽고, 지하·복합 표기는 무시", () => {
    expect(parseFloorText("5F")).toBe(5);
    expect(parseFloorText(" 12 f ")).toBe(12);
    expect(parseFloorText("7층")).toBe(7);
    expect(parseFloorText("3")).toBe(3);
    expect(parseFloorText("{\\fArial|b0;15F}")).toBe(15);
    expect(parseFloorText("B1")).toBeNull();
    expect(parseFloorText("5F/2F")).toBeNull();
    expect(parseFloorText("0")).toBeNull();
    expect(parseFloorText("주차장")).toBeNull();
  });

  it("BLDG_FLOORS 문자가 외곽선 안에 있으면 그 층수로 불러온다", () => {
    const text = dxfText({
      entities:
        rectEntity("ADJ_BLDG", 0, 0, 10000, 10000) +
        rectEntity("ADJ_BLDG", 20000, 0, 30000, 10000) +
        textEntity("BLDG_FLOORS", 5000, 5000, "4F") +
        textEntity("BLDG_FLOORS", 25000, 5000, "9F", true),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings.map((b) => b.floors)).toEqual([4, 9]);
    expect(r.floorsFromText).toBe(2);
  });

  it("문자가 없는 동은 기본 1층", () => {
    const text = dxfText({
      entities:
        rectEntity("ADJ_BLDG", 0, 0, 10000, 10000) +
        rectEntity("ADJ_BLDG", 20000, 0, 30000, 10000) +
        textEntity("BLDG_FLOORS", 5000, 5000, "6F"),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings.map((b) => b.floors)).toEqual([6, 1]);
  });

  it("층수 문자가 레이어 접미사(_15F)보다 우선한다", () => {
    const text = dxfText({
      entities: rectEntity("PLAN_A_1_15F", 0, 0, 10000, 10000) + textEntity("BLDG_FLOORS", 5000, 5000, "23F"),
    });
    expect(parseDxfBuildings(text, "mm").buildings[0].floors).toBe(23);
  });

  it("건물과 같은 레이어에 적은 숫자 문자도 인정, MTEXT도 읽는다", () => {
    const text = dxfText({
      entities:
        rectEntity("PLAN_A_1", 0, 0, 10000, 10000) +
        mtextEntity("PLAN_A_1", 5000, 5000, "{\\fArial|b0;18층}"),
    });
    expect(parseDxfBuildings(text, "mm").buildings[0].floors).toBe(18);
  });

  it("엉뚱한 레이어의 숫자(치수·세대수 등)는 층수로 쓰지 않는다", () => {
    const text = dxfText({
      entities: rectEntity("ADJ_BLDG", 0, 0, 10000, 10000) + textEntity("DIM", 5000, 5000, "36"),
    });
    expect(parseDxfBuildings(text, "mm").buildings[0].floors).toBe(1);
  });

  it("외곽선 밖에 떨어진 층수 문자는 무시하고 알린다", () => {
    const text = dxfText({
      entities: rectEntity("ADJ_BLDG", 0, 0, 10000, 10000) + textEntity("BLDG_FLOORS", 50000, 5000, "5F"),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].floors).toBe(1);
    expect(r.warnings.some((w) => w.includes("어떤 건물 외곽선 안에도"))).toBe(true);
  });

  it("한 동에 서로 다른 층수가 적혀 있으면 큰 값을 쓰고 알린다", () => {
    const text = dxfText({
      entities:
        rectEntity("ADJ_BLDG", 0, 0, 10000, 10000) +
        textEntity("BLDG_FLOORS", 3000, 5000, "3F") +
        textEntity("BLDG_FLOORS", 7000, 5000, "5F"),
    });
    const r = parseDxfBuildings(text, "mm");
    expect(r.buildings[0].floors).toBe(5);
    expect(r.warnings.some((w) => w.includes("가장 큰 값"))).toBe(true);
  });
});

describe("인접건물 이름 (26동 초과 회귀)", () => {
  it("letterSeq — A…Z 다음은 AA, AB …", () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(letterSeq)).toEqual([
      "A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA",
    ]);
  });

  it("30동을 불러와도 이름이 깨지지 않는다", () => {
    let ents = "";
    for (let i = 0; i < 30; i++) ents += rectEntity("ADJ_BLDG", i * 20000, 0, i * 20000 + 10000, 10000);
    const names = parseDxfBuildings(dxfText({ entities: ents }), "mm").buildings.map((b) => b.name);
    expect(names[25]).toBe("인접건물 Z");
    expect(names[26]).toBe("인접건물 AA");
    expect(names.every((n) => /^인접건물 [A-Z]+$/.test(n))).toBe(true);
  });
});
