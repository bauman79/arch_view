import { checkCommonEntityProperties } from "dxf-parser/dist/ParseHelpers.js";

/**
 * dxf-parser 1.1.2의 LWPOLYLINE 핸들러 교체본.
 *
 * 원본 파서(entities/lwpolyline.js)는 버텍스 목록을 별도 내부 루프로 읽는데,
 * 그 루프가 모르는 그룹코드를 만나면 **버텍스 파싱을 즉시 중단**한다.
 * AutoCAD 2013+ 형식(AC1027)은 각 버텍스의 10/20 다음에 vertex ID(그룹코드 91)를
 * 기록하므로, 실무 도면의 LWPOLYLINE은 첫 버텍스 1개만 파싱되어
 * PLAN_WIN 매칭·footprint 인식이 조용히 실패한다 (LINE 엔티티는 별도 경로라 정상).
 *
 * 이 교체본은 버텍스를 평평한 switch 한 개로 읽어 모르는 코드(91 등)를
 * 그룹 단위로 건너뛴다. 반환 형태는 원본과 동일:
 * { type, vertices: [{x,y}], shape, extrusionDirectionX/Y/Z, ... }
 */
export class FixedLwpolylineParser {
  ForEntityName = "LWPOLYLINE" as const;

  parseEntity(scanner: any, curr: any): any {
    const entity: any = { type: curr.value, vertices: [] };
    curr = scanner.next();
    while (!scanner.isEOF()) {
      if (curr.code === 0) break;
      const last = entity.vertices[entity.vertices.length - 1];
      switch (curr.code) {
        case 38:
          entity.elevation = curr.value;
          break;
        case 39:
          entity.depth = curr.value;
          break;
        case 70: // 비트 1 = closed
          entity.shape = (curr.value & 1) === 1;
          entity.hasContinuousLinetypePattern = (curr.value & 128) === 128;
          break;
        case 90: // 버텍스 개수 선언 — 코드 10 등장 횟수로 대신 세므로 불필요
          break;
        case 10: // 새 버텍스 시작
          entity.vertices.push({ x: curr.value, y: 0 });
          break;
        case 20:
          if (last) last.y = curr.value;
          break;
        case 40:
          if (last) last.startWidth = curr.value;
          break;
        case 41:
          if (last) last.endWidth = curr.value;
          break;
        case 42:
          if (last && curr.value !== 0) last.bulge = curr.value;
          break;
        case 43:
          if (curr.value !== 0) entity.width = curr.value;
          break;
        case 91: // AC1027+ vertex ID — 무시 (원본 파서는 여기서 버텍스 파싱을 중단했다)
          break;
        case 210:
          entity.extrusionDirectionX = curr.value;
          break;
        case 220:
          entity.extrusionDirectionY = curr.value;
          break;
        case 230:
          entity.extrusionDirectionZ = curr.value;
          break;
        default:
          checkCommonEntityProperties(entity, curr, scanner);
          break;
      }
      curr = scanner.next();
    }
    return entity;
  }
}
