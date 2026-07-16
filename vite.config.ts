import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      // 캐시 전략을 직접 제어하기 위해 커스텀 서비스워커(src/sw.ts) 주입 방식 사용
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: {
        // 앱 셸(JS/CSS/HTML/아이콘)만 프리캐시 — DXF·EPW는 로컬 업로드/대용량이라 제외
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        globIgnores: ["**/*.{dxf,epw}", "**/node_modules/**"],
        // three.js 번들이 1.3MB — 기본 한도(2MB)에 근접해 여유를 둔다
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "ArchView — 일조·태양광 시뮬레이터",
        short_name: "ArchView",
        description:
          "공동주택 배치 검토 도구 — 정북사선·채광사선·인동거리·일조권·태양광(PV)·바람길 분석",
        lang: "ko",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#0f1929", // 툴바 색
        background_color: "#070d1a", // 캔버스 색
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
});
