import { computeWindField, traceStreamlines, type Streamline } from "./wind";
import type { Building, Site } from "./types";

/**
 * 바람길 간이 분석(M8) 워커 — 대형 배치도(주변 600여 동)에서 속도장 계산이 수 초 걸려
 * 화면이 멈추던 것을 백그라운드로 옮긴다. 결과(유선·바람그림자 면적)만 돌려준다.
 */

export interface WindRunMessage {
  buildings: Building[];
  site: Site;
  windDirDeg: number;
  gridM: number;
  refHeightM: number;
  lineCount: number;
}

export interface WindDoneMessage {
  streamlines: Streamline[];
  shadowAreaM2: number;
}

self.onmessage = (ev: MessageEvent<WindRunMessage>) => {
  const m = ev.data;
  const field = computeWindField(m.buildings, m.site, m.windDirDeg, m.gridM, m.refHeightM);
  const streamlines = traceStreamlines(field, m.lineCount);
  const out: WindDoneMessage = { streamlines, shadowAreaM2: field.shadowAreaM2 };
  (self as unknown as Worker).postMessage(out);
};
