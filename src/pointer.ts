/**
 * 포인터 입력 판정 — 클릭/탭과 드래그를 가르는 순수 로직.
 *
 * 캔버스 조작(main.ts)에서 쓰지만 DOM/Three.js에 의존하지 않도록 분리해 두었다.
 * 임계값이 잘못되면 "선택했는데 건물이 밀린다"·"탭해도 선택이 안 된다"처럼
 * 조용히 어긋나는 버그가 되므로 회귀 테스트 대상이다.
 */

export interface PointPx {
  x: number;
  y: number;
}

/**
 * 클릭/탭으로 볼 최대 포인터 이동 거리(px).
 *
 * 손가락은 탭하는 동안에도 5~10px씩 흔들리므로 마우스보다 넉넉해야 한다.
 * 마우스 기준(4px)을 터치에 그대로 쓰면 태블릿에서 "선택"이 매번 "이동"으로
 * 처리되어 배치가 밀리고 분석 결과까지 무효화된다.
 * pen(스타일러스)은 손 떨림이 있어 터치와 같은 값을 쓴다.
 */
export function tapSlopPx(pointerType: string): number {
  return pointerType === "mouse" ? 4 : 12;
}

/**
 * pointerdown 지점 대비 아직 탭 범위 안인가.
 * @param down pointerdown 지점 — null이면 시작점을 모르므로 탭으로 보지 않는다
 */
export function isTap(
  pointerType: string,
  down: PointPx | null,
  cur: PointPx,
): boolean {
  if (!down) return false;
  return Math.hypot(cur.x - down.x, cur.y - down.y) < tapSlopPx(pointerType);
}

/** isTap의 여집합 — 드래그로 처리해야 하는가 */
export function isDrag(
  pointerType: string,
  down: PointPx | null,
  cur: PointPx,
): boolean {
  return !isTap(pointerType, down, cur);
}
