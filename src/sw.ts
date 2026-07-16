/// <reference lib="webworker" />
// PWA 서비스워커 (vite-plugin-pwa injectManifest 모드가 빌드 시 번들·주입).
// 전략: 앱 셸(JS/CSS/HTML/아이콘)은 프리캐시 → 완전 오프라인 동작.
// DXF·EPW는 절대 캐시하지 않음(도면은 로컬 업로드라 불필요, EPW는 대용량).
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  matchPrecache,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute, setCatchHandler } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope;

// 새 버전 배포 시 대기 없이 즉시 교체 (registerType: "autoUpdate"와 세트)
self.skipWaiting();
clientsClaim();

// 앱 셸 프리캐시 — __WB_MANIFEST는 빌드 시 vite-plugin-pwa가 파일 목록으로 치환
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// DXF·EPW는 항상 네트워크만 — 어떤 캐시에도 넣지 않는다
registerRoute(
  ({ url }) => /\.(dxf|epw)$/i.test(url.pathname),
  new NetworkOnly(),
);

// SPA 내비게이션은 프리캐시된 앱 셸로 (정확히 프리캐시에 있는 URL은 위 프리캐시 라우트가 우선)
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// 최후 폴백 — 앱 셸조차 없이 오프라인이면 offline.html(프리캐시됨) 표시
setCatchHandler(async ({ request }) => {
  if (request.mode === "navigate") {
    const offline = await matchPrecache("offline.html");
    if (offline) return offline;
  }
  return Response.error();
});
