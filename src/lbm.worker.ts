import {
  LBM_CONV_STREAK,
  LBM_CONV_TOL,
  LBM_MAX_STEPS,
  LbmSolver,
  type LbmDomain,
} from "./lbm";

/**
 * M10 — LBM 시뮬레이션 WebWorker.
 * 메인 스레드가 만든 LbmDomain을 받아 수렴(연속 10스텝 잔차<0.1%)까지 스텝을 돌리고,
 * PROGRESS_EVERY 스텝마다 속도비 Float32Array를 transferable로 보내 히트맵을 실시간
 * 갱신한다. "stop" 메시지를 받으려면 청크 사이에 이벤트 루프를 양보해야 한다 —
 * pv.ts의 MessageChannel 패턴을 그대로 쓰되, three.js 의존을 워커 번들에 끌고
 * 들어오지 않도록 여기 로컬로 둔다.
 */

/** 진행 보고·양보 주기 (스텝) */
const PROGRESS_EVERY = 25;

export interface LbmRunMessage {
  type: "run";
  domain: LbmDomain;
  maxSteps?: number;
}

export interface LbmStopMessage {
  type: "stop";
}

export interface LbmProgressMessage {
  type: "progress";
  step: number;
  /** 이번 스텝 최대 속도 변화율 (유입속도 대비) */
  residual: number;
  /** 속도비 U/U₀ (transferable) */
  ratio: Float32Array;
}

export interface LbmDoneMessage {
  type: "done";
  steps: number;
  converged: boolean;
  /** true면 stop 요청으로 중단된 결과 (수렴 아님) */
  stopped: boolean;
  /** 로컬(흐름 정렬) 속도 성분, lattice units (transferable) */
  ux: Float32Array;
  uy: Float32Array;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

let stopRequested = false;
let running = false;

async function run(domain: LbmDomain, maxSteps: number): Promise<void> {
  running = true;
  stopRequested = false;
  const solver = new LbmSolver(domain);
  let streak = 0;
  let steps = 0;
  let converged = false;

  while (steps < maxSteps && !converged && !stopRequested) {
    let residual = Infinity;
    const chunkEnd = Math.min(steps + PROGRESS_EVERY, maxSteps);
    while (steps < chunkEnd && !converged) {
      residual = solver.step();
      steps++;
      streak = residual < LBM_CONV_TOL ? streak + 1 : 0;
      if (streak >= LBM_CONV_STREAK) converged = true;
    }
    if (!converged && !stopRequested) {
      const ratio = solver.speedRatio();
      const msg: LbmProgressMessage = { type: "progress", step: steps, residual, ratio };
      postMessage(msg, { transfer: [ratio.buffer] });
      await yieldToEventLoop(); // stop 메시지 수신 기회
    }
  }

  const ux = solver.ux;
  const uy = solver.uy;
  const done: LbmDoneMessage = {
    type: "done",
    steps,
    converged,
    stopped: stopRequested && !converged,
    ux,
    uy,
  };
  postMessage(done, { transfer: [ux.buffer, uy.buffer] });
  running = false;
}

onmessage = (ev: MessageEvent<LbmRunMessage | LbmStopMessage>) => {
  const msg = ev.data;
  if (msg.type === "run") {
    if (running) return; // 중복 실행 방지 — 메인이 워커를 새로 만드는 것이 정상 경로
    void run(msg.domain, msg.maxSteps ?? LBM_MAX_STEPS);
  } else if (msg.type === "stop") {
    stopRequested = true;
  }
};
