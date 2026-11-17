import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";

/** 모형 스타일 색 — 흰 점토 모형 느낌 (삽도용) */
const MODEL_BG = 0xf3f2ee;
const MODEL_COLOR = {
  plan: 0xf6f4ee,
  adj: 0xcdccc6,
  edge: 0x77756e,
  terrain: 0xe8e6df,
  terrainEdge: 0xa19e95,
  site: 0xdde6d3,
  road: 0xc6c7c8,
};

/** 표준 시점 프리셋 — 태블릿에서 두 손가락으로 각도를 맞추기 어려운 점을 보완 */
export type ViewPreset = "iso" | "top" | "south" | "east" | "west";

export const VIEW_PRESET_LABEL: Record<ViewPreset, string> = {
  iso: "아이소",
  top: "평면",
  south: "남측",
  east: "동측",
  west: "서측",
};

/**
 * 프리셋별 카메라 방향(장면 중심 → 카메라). three 좌표계에서 +z가 남쪽이다.
 *
 * top(평면)은 정확히 수직(0,1,0)으로 두면 카메라 up 벡터와 평행해져 OrbitControls가
 * 짐벌락에 걸리므로 남쪽으로 아주 조금 눕혀 둔다.
 * 입면 시점들도 완전 수평(y=0)이면 지면이 선으로만 보여 방향을 잃기 쉬워 살짝 내려다본다.
 */
const VIEW_PRESET_DIR: Record<ViewPreset, THREE.Vector3> = {
  iso: new THREE.Vector3(0.7, 0.8, 1),
  top: new THREE.Vector3(0, 1, 0.02),
  south: new THREE.Vector3(0, 0.25, 1),
  east: new THREE.Vector3(1, 0.25, 0),
  west: new THREE.Vector3(-1, 0.25, 0),
};

/**
 * Three.js 뷰포트. DXF XY 평면(Y+=북) → Three.js에서는
 * x=동, y=높이(상), z=-북 으로 매핑한다.
 */
export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  /** 건물 그룹들이 담기는 루트 */
  readonly buildingsRoot = new THREE.Group();
  /** DXF SITE_BOUNDARY/ADJ_BOUNDARY/ROAD_CL/PARK_BOUNDARY 참고선이 담기는 루트 (비인터랙티브) */
  readonly overlaysRoot = new THREE.Group();
  /** M7 TIN 지형 메시 루트 (비인터랙티브 — 드래그 groundHit는 여전히 y=0 평면 기준) */
  readonly terrainRoot = new THREE.Group();
  /** 태양 방향 직사광 (setSun으로 갱신) */
  readonly sunLight: THREE.DirectionalLight;

  private container: HTMLElement;
  private groundHelpers: THREE.Object3D[] = [];
  /** 기본 바닥·격자 크기(m) — 장면이 커지면 adaptToScene()이 배율로 늘린다 */
  private static readonly BASE_GROUND = 400;
  /** 태양광원까지 거리(m) — 그림자 카메라가 장면 전체를 담도록 장면 크기에 맞춘다 */
  private sunDistance = 500;
  private resizeObserver: ResizeObserver | null = null;
  /** 모형 스타일(흰 점토 + 앰비언트 오클루전) — 삽도용 */
  modelStyle = false;
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  /** AO 계산용 카메라 — 라벨(레이어 1)을 빼고 본다 (라벨이 검은 판으로 찍히지 않게) */
  private aoCamera = new THREE.PerspectiveCamera();
  /** AO 반경(m) — 장면 크기에 맞춤 */
  private aoRadius = 6;
  private hemi: THREE.HemisphereLight | null = null;
  private groundHelperVis: boolean[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene.background = new THREE.Color(0x070d1a);
    this.scene.fog = new THREE.Fog(0x070d1a, 600, 1600);

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      1,
      5000,
    );
    this.camera.position.set(80, 90, 120);
    this.camera.layers.enable(1); // 레이어 1 = 라벨 (AO 계산에서 제외)

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 4; // 근접 한계(near)보다 충분히 멀게
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // 지면 아래로 안 내려가게

    // 태양 직사광 — M2: setSun(방향벡터)으로 시간대별 갱신
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const cam = this.sunLight.shadow.camera;
    cam.left = -250;
    cam.right = 250;
    cam.top = 250;
    cam.bottom = -250;
    cam.near = 1;
    cam.far = 1500;
    // 그림자가 자기 면에 줄무늬로 맺히는 현상(shadow acne) 방지 — normalBias는 장면 크기에 맞춰 갱신
    this.sunLight.shadow.bias = -0.0002;
    this.sunLight.shadow.normalBias = 0.25;
    this.sunLight.position.set(60, 120, 100); // 초기값 — 남측 상공
    this.scene.add(this.sunLight, this.sunLight.target);

    this.setupLightsAndGround();
    this.scene.add(this.buildingsRoot, this.overlaysRoot, this.terrainRoot);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    window.addEventListener("resize", () => this.onResize());
    this.renderer.setAnimationLoop(() => {
      // 0×0으로 초기화된 뒤 컨테이너가 커지는 경우(옵저버 미발화 환경) 대비
      if (
        this.renderer.domElement.width === 0 &&
        this.container.clientWidth > 0
      ) {
        this.onResize();
      }
      this.controls.update();
      this.renderFrame();
    });
  }

  /**
   * 태양 방향(지점→태양 단위벡터, three 좌표) 설정.
   * null이면 태양이 지평선 아래 — 직사광 끔.
   */
  setSun(dir: THREE.Vector3 | null): void {
    if (!dir) {
      this.sunLight.visible = false;
      return;
    }
    this.sunLight.visible = true;
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.position.copy(dir).multiplyScalar(this.sunDistance);
  }

  private setupLightsAndGround(): void {
    const hemi = new THREE.HemisphereLight(0xdde4f0, 0x30343c, 1.0);
    this.hemi = hemi;
    this.scene.add(hemi);

    const grid = new THREE.GridHelper(400, 80, 0x1e2d4a, 0x131e35);
    this.scene.add(grid);
    this.groundHelpers.push(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshLambertMaterial({ color: 0x0b1322 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.groundHelpers.push(ground);

    // 정북(-Z) 화살표
    const north = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 0.1, 0),
      30,
      0xdd6666,
      6,
      3,
    );
    this.scene.add(north);
  }

  /** 건물 + 오버레이(대지경계 등) + 지형 전체를 감싸는 박스 — 비어 있으면 null */
  private sceneBox(): THREE.Box3 | null {
    const box = new THREE.Box3().setFromObject(this.buildingsRoot);
    const overlayBox = new THREE.Box3().setFromObject(this.overlaysRoot);
    if (!overlayBox.isEmpty()) box.union(overlayBox);
    const terrainBox = new THREE.Box3().setFromObject(this.terrainRoot);
    if (!terrainBox.isEmpty()) box.union(terrainBox);
    return box.isEmpty() ? null : box;
  }

  /**
   * 바닥·격자·그림자·안개 범위를 장면 크기에 맞춘다.
   * 고정값(바닥 400m, 그림자 ±250m, 안개 600~1600m)은 단지 하나 정도를 가정한 값이라,
   * 주변 필지까지 포함한 1km 규모 배치도를 불러오면 바닥이 모자라고 그림자가 잘리며
   * 카메라를 장면 전체가 보이게 물리면 안개에 묻힌다. 작은 장면은 기존 값을 그대로 쓴다.
   */
  private adaptToScene(center: THREE.Vector3, radius: number): void {
    const base = Viewer.BASE_GROUND;
    const span = Math.max(base, radius * 3);
    for (const h of this.groundHelpers) {
      if (h instanceof THREE.GridHelper) {
        h.scale.set(span / base, 1, span / base);
        h.position.set(center.x, 0, center.z);
      } else if (h instanceof THREE.Mesh) {
        h.scale.set(span / base, span / base, 1); // 바닥 평면은 x축 -90° 회전 → 로컬 y가 월드 z
        h.position.set(center.x, -0.05, center.z);
      }
    }
    const half = Math.max(250, radius * 1.1);
    const cam = this.sunLight.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    this.sunDistance = Math.max(500, radius * 2);
    cam.far = Math.max(1500, this.sunDistance + radius * 2);
    cam.updateProjectionMatrix();
    // 넓은 장면은 그림자 해상도를 올려 m당 텍셀 밀도를 유지한다
    const want = half > 300 ? 4096 : 2048;
    if (this.sunLight.shadow.mapSize.x !== want) {
      this.sunLight.shadow.mapSize.set(want, want);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    // 태양 방향은 유지한 채 거리만 갱신
    if (this.sunLight.position.lengthSq() > 0) {
      this.sunLight.position.setLength(this.sunDistance);
    }
    // 앰비언트 오클루전 반경 — 단지 규모에 맞춰 (건물 사이 골목·모서리 음영)
    this.aoRadius = Math.min(12, Math.max(3, radius / 60));
    this.gtao?.updateGtaoMaterial({ radius: this.aoRadius, thickness: this.aoRadius * 1.5 });
    // 그림자 맵 텍셀 크기에 비례한 법선 오프셋 — 넓은 장면일수록 텍셀이 커서 줄무늬가 잘 생긴다
    this.sunLight.shadow.normalBias = Math.max(0.15, ((2 * half) / want) * 1.5);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(600, radius * 2.5);
    fog.far = Math.max(1600, radius * 8);
    this.camera.far = Math.max(5000, radius * 12);
    // 근접 한계를 키워 깊이 정밀도 확보 — 0.1m면 500m 거리에서 정밀도가 15cm라
    // 지형 위 채움·히트맵이 지형과 겹쳐 지글거린다. 1km 장면도 1~2m면 충분히 가깝게 볼 수 있다.
    this.camera.near = Math.min(2, Math.max(0.5, radius / 400));
    this.camera.updateProjectionMatrix();
  }

  /** 건물 + 오버레이(대지경계 등) + 지형 전체 바운딩 박스에 맞춰 카메라를 이동 */
  fitToBuildings(): void {
    this.setViewPreset("iso");
  }

  /**
   * 표준 시점으로 카메라 이동 — 장면 전체가 화면에 들어오도록 거리도 함께 맞춘다.
   *
   * 좌표 규약: three x=동, y=높이, z=-북 (즉 +z가 남쪽).
   * "남측 입면"은 남쪽(+z)에서 북쪽을 바라보는 시점이다.
   */
  setViewPreset(preset: ViewPreset): void {
    const box = this.sceneBox();
    if (!box) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, size.y) * 0.9 + 20;
    this.adaptToScene(center, radius);

    const dir = VIEW_PRESET_DIR[preset].clone().normalize();
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .addScaledVector(dir, radius * (preset === "iso" ? 1.35 : 1.25));
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 한 프레임 그리기 — 모형 스타일이면 색을 맞추고 AO 후처리를 거친다 */
  private renderFrame(): void {
    if (this.modelStyle && this.composer) {
      this.applyModelColors();
      this.syncAoCamera();
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private syncAoCamera(): void {
    this.aoCamera.copy(this.camera);
    this.aoCamera.layers.set(0);
  }

  /** 모형 스타일 켜기/끄기 */
  setModelStyle(on: boolean): void {
    if (on === this.modelStyle) return;
    this.modelStyle = on;
    if (on) {
      if (!this.composer) {
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;
        const comp = new EffectComposer(this.renderer);
        comp.addPass(new RenderPass(this.scene, this.camera));
        this.syncAoCamera();
        const ao = new GTAOPass(this.scene, this.aoCamera, w, h);
        ao.updateGtaoMaterial({ radius: this.aoRadius, distanceExponent: 1, thickness: this.aoRadius * 1.5, scale: 1.2, samples: 16 });
        ao.blendIntensity = 1;
        comp.addPass(ao);
        comp.addPass(new OutputPass());
        comp.setPixelRatio(this.renderer.getPixelRatio());
        comp.setSize(w, h);
        this.composer = comp;
        this.gtao = ao;
      }
      this.scene.background = new THREE.Color(MODEL_BG);
      (this.scene.fog as THREE.Fog).color.setHex(MODEL_BG);
      this.groundHelperVis = this.groundHelpers.map((g) => g.visible);
      for (const g of this.groundHelpers) g.visible = false;
      if (this.hemi) {
        this.hemi.color.setHex(0xffffff);
        this.hemi.groundColor.setHex(0x8a8780);
        this.hemi.intensity = 1.35;
      }
    } else {
      this.scene.background = new THREE.Color(0x070d1a);
      (this.scene.fog as THREE.Fog).color.setHex(0x070d1a);
      this.groundHelpers.forEach((g, i) => (g.visible = this.groundHelperVis[i] ?? true));
      if (this.hemi) {
        this.hemi.color.setHex(0xdde4f0);
        this.hemi.groundColor.setHex(0x30343c);
        this.hemi.intensity = 1.0;
      }
      this.restoreColors();
    }
  }

  /** 모형 색 지정 대상 판별 — 원래 색은 userData에 보관해 끌 때 되돌린다 */
  private modelColorFor(obj: THREE.Object3D): number | null {
    let bType: string | undefined;
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
      if (o.userData.buildingType) {
        bType = o.userData.buildingType as string;
        break;
      }
    }
    const isLine = (obj as THREE.LineSegments).isLineSegments || (obj as THREE.Line).isLine;
    if ((obj as THREE.Sprite).isSprite) return null;
    if (bType) {
      if (obj.name === "window-hilite") return null;
      if (isLine) return MODEL_COLOR.edge;
      return bType === "계획주동" ? MODEL_COLOR.plan : MODEL_COLOR.adj;
    }
    const n = obj.name;
    const parentName = obj.parent?.name ?? "";
    if (n === "terrain-solid" || (parentName === "terrain-stepped" && !isLine)) return MODEL_COLOR.terrain;
    if (parentName === "terrain-stepped" && isLine) return MODEL_COLOR.terrainEdge;
    if (n === "site-drape" || n === "site-fill") return MODEL_COLOR.site;
    if (n === "road-drape" || n === "road-fill") return MODEL_COLOR.road;
    return null;
  }

  private applyModelColors(): void {
    for (const root of [this.buildingsRoot, this.terrainRoot, this.overlaysRoot]) {
      root.traverse((obj) => {
        if (obj.userData.modelStyled) return;
        if (obj.name === "window-hilite") {
          // 창면 강조(파란 면)는 검토용 — 모형 스타일에서는 숨긴다
          obj.userData.modelStyled = true;
          obj.userData.wasVisible = obj.visible;
          obj.visible = false;
          return;
        }
        const mat = (obj as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (!mat || Array.isArray(mat) || !mat.color) return;
        const c = this.modelColorFor(obj);
        obj.userData.modelStyled = true;
        if (c === null) return;
        obj.userData.origColor = mat.color.getHex();
        mat.color.setHex(c);
      });
    }
  }

  private restoreColors(): void {
    for (const root of [this.buildingsRoot, this.terrainRoot, this.overlaysRoot]) {
      root.traverse((obj) => {
        if (!obj.userData.modelStyled) return;
        if (obj.userData.wasVisible !== undefined) {
          obj.visible = obj.userData.wasVisible;
          delete obj.userData.wasVisible;
        }
        const mat = (obj as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (mat && !Array.isArray(mat) && obj.userData.origColor !== undefined) mat.color.setHex(obj.userData.origColor);
        delete obj.userData.modelStyled;
        delete obj.userData.origColor;
      });
    }
  }

  /** 화면에서 정북이 가리키는 각도 (라디안, 화면 위쪽 = 0, 시계방향 +) — 방위표용 */
  screenNorthAngle(northAngleDeg: number): number {
    const t = this.controls.target.clone();
    const th = THREE.MathUtils.degToRad(northAngleDeg);
    // 도면 진북 (−sinθ, cosθ) → three (x, −y)
    const n = t.clone().add(new THREE.Vector3(-Math.sin(th) * 10, 0, -Math.cos(th) * 10));
    const a = t.clone().project(this.camera);
    const b = n.project(this.camera);
    return Math.atan2(b.x - a.x, b.y - a.y);
  }

  /** 바라보는 점 부근에서 1m가 몇 화면 px인지 + 내려다보는 정도(1=수직) — 축척 막대용 */
  scaleAtTarget(): { pxPerM: number; downness: number } {
    const w = this.container.clientWidth;
    const t = this.controls.target.clone();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
    const a = t.clone().project(this.camera);
    const b = t.clone().add(right.multiplyScalar(10)).project(this.camera);
    const pxPerM = (Math.hypot(b.x - a.x, b.y - a.y) * w) / 2 / 10;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return { pxPerM, downness: -dir.y };
  }

  /** 현재 카메라 시점 (위치·바라보는 점) */
  getCameraView(): { position: [number, number, number]; target: [number, number, number] } {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  private viewAnim = 0;

  /** 저장한 시점으로 부드럽게 이동 (0.6초) */
  flyTo(position: [number, number, number], target: [number, number, number]): void {
    const p0 = this.camera.position.clone();
    const t0 = this.controls.target.clone();
    const p1 = new THREE.Vector3(...position);
    const t1 = new THREE.Vector3(...target);
    const start = performance.now();
    const DUR = 600;
    const id = ++this.viewAnim;
    const step = () => {
      if (id !== this.viewAnim) return; // 새 이동이 시작되면 이전 애니메이션 중단
      const k = Math.min(1, (performance.now() - start) / DUR);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
      this.camera.position.lerpVectors(p0, p1, e);
      this.controls.target.lerpVectors(t0, t1, e);
      this.controls.update();
      if (k < 1) requestAnimationFrame(step);
      else this.viewAnim++; // 완료 — 아래 안전장치가 다시 손대지 않게
    };
    step();
    // rAF가 멈춘 환경(백그라운드 탭 등)에서도 최종 시점에는 반드시 도착하도록
    setTimeout(() => {
      if (id !== this.viewAnim) return;
      this.camera.position.copy(p1);
      this.controls.target.copy(t1);
      this.controls.update();
      this.viewAnim++;
    }, DUR + 150);
  }

  /**
   * 지금 화면을 JPG로 캡처 — 화면 크기의 최대 2배 해상도(긴 변 4096px 이하).
   * 렌더 직후 같은 작업 안에서 toBlob을 호출해 preserveDrawingBuffer 없이도 캡처된다.
   */
  captureJpeg(
    quality = 0.92,
    overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number, scale: number) => void,
    opts: { whiteBackground?: boolean } = {},
  ): Promise<Blob> {
    const r = this.renderer;
    const prev = r.getPixelRatio();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const ratio = Math.max(prev, Math.min(2, 4096 / Math.max(w, h, 1)));
    r.setPixelRatio(ratio);
    r.setSize(w, h);
    this.controls.update();
    // 삽도용 — 저장할 때만 그림자 맵을 GPU 한도(최대 8192)까지 키워 경계를 선명하게
    const sh = this.sunLight.shadow;
    const prevMap = sh.mapSize.x;
    const prevBias = sh.normalBias;
    const hi = Math.min(8192, r.capabilities.maxTextureSize);
    if (hi > prevMap) {
      sh.mapSize.set(hi, hi);
      sh.map?.dispose();
      sh.map = null;
      sh.normalBias = prevBias * (prevMap / hi) * 1.5;
    }
    // 흰 배경 — 배경·안개·격자·바닥판을 잠시 끈다
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    const helperVis = this.groundHelpers.map((g) => g.visible);
    if (opts.whiteBackground) {
      this.scene.background = new THREE.Color(0xffffff);
      this.scene.fog = null;
      for (const g of this.groundHelpers) g.visible = false;
    }
    if (this.modelStyle && this.composer) {
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(w, h);
      this.applyModelColors();
      this.syncAoCamera();
      this.composer.render();
    } else {
      r.render(this.scene, this.camera);
    }
    // 렌더 직후(같은 작업 안) 2D 캔버스로 옮겨 범례 등을 덧그린다
    const out = document.createElement("canvas");
    out.width = r.domElement.width;
    out.height = r.domElement.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(r.domElement, 0, 0);
    overlay?.(ctx, out.width, out.height, out.width / Math.max(1, w));
    const blob = new Promise<Blob>((resolve, reject) => {
      out.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("이미지 캡처 실패"))),
        "image/jpeg",
        quality,
      );
    });
    r.setPixelRatio(prev);
    r.setSize(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(prev);
      this.composer.setSize(w, h);
    }
    if (hi > prevMap) {
      sh.mapSize.set(prevMap, prevMap);
      sh.map?.dispose();
      sh.map = null;
      sh.normalBias = prevBias;
    }
    if (opts.whiteBackground) {
      this.scene.background = prevBg;
      this.scene.fog = prevFog;
      this.groundHelpers.forEach((g, i) => (g.visible = helperVis[i]));
    }
    return blob;
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }
}
