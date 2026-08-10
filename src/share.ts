/**
 * 결과 파일 공유 — 태블릿에서 엑셀·DXF를 OS 공유 시트(메일·메신저·파일 앱)로 넘긴다.
 *
 * iPad에서 다운로드는 파일 앱을 거쳐야 해서 배치안을 바로 전달하기 번거롭다.
 * Web Share Level 2(파일 공유)를 지원하면 공유 시트를 띄우고, 아니면 기존
 * 다운로드로 폴백한다 — 데스크톱 브라우저 대부분은 폴백 경로를 탄다.
 *
 * 공유 대상 선택과 최종 전송은 OS 공유 시트에서 사용자가 직접 하며,
 * 이 모듈은 어디로도 자동 전송하지 않는다.
 */

export type ShareOutcome = "shared" | "downloaded" | "cancelled";

/** 이 브라우저가 해당 파일을 공유 시트로 넘길 수 있는가 */
export function canShareFile(file: File): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    typeof navigator.share === "function" &&
    navigator.canShare({ files: [file] })
  );
}

/** Blob을 파일로 저장 (공유 미지원 환경 폴백) */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 공유 시트로 넘기거나, 불가능하면 다운로드한다.
 *
 * @returns "shared" = 공유 시트에서 전송 완료 · "cancelled" = 사용자가 공유 시트를 닫음
 *          · "downloaded" = 공유 미지원이라 파일로 저장
 */
export async function shareOrDownload(
  file: File,
  title: string,
): Promise<ShareOutcome> {
  if (!canShareFile(file)) {
    downloadBlob(file, file.name);
    return "downloaded";
  }
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    // 사용자가 공유 시트를 닫으면 AbortError — 실패가 아니므로 조용히 끝낸다
    if ((err as Error)?.name === "AbortError") return "cancelled";
    // 그 외 오류(권한·미지원 등)는 파일을 잃지 않도록 다운로드로 되돌린다
    downloadBlob(file, file.name);
    return "downloaded";
  }
}

/** 텍스트 결과(DXF·.view)를 공유하거나 저장 */
export async function shareOrDownloadText(
  text: string,
  filename: string,
  mime: string,
  title: string,
): Promise<ShareOutcome> {
  return shareOrDownload(new File([text], filename, { type: mime }), title);
}
