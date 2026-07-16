import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene.background = new THREE.Color(0x070d1a);
    this.scene.fog = new THREE.Fog(0x070d1a, 600, 1600);

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      5000,
    );
    this.camera.position.set(80, 90, 120);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
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
    this.sunLight.shadow.bias = -0.0005;
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
      this.renderer.render(this.scene, this.camera);
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
    this.sunLight.position.copy(dir).multiplyScalar(500);
  }

  private setupLightsAndGround(): void {
    const hemi = new THREE.HemisphereLight(0xdde4f0, 0x30343c, 1.0);
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

  /** 건물 + 오버레이(대지경계 등) + 지형 전체 바운딩 박스에 맞춰 카메라를 이동 */
  fitToBuildings(): void {
    const box = new THREE.Box3().setFromObject(this.buildingsRoot);
    const overlayBox = new THREE.Box3().setFromObject(this.overlaysRoot);
    if (!overlayBox.isEmpty()) box.union(overlayBox);
    const terrainBox = new THREE.Box3().setFromObject(this.terrainRoot);
    if (!terrainBox.isEmpty()) box.union(terrainBox);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, size.y) * 0.9 + 20;
    this.controls.target.copy(center);
    this.camera.position.set(
      center.x + radius * 0.7,
      center.y + radius * 0.8,
      center.z + radius,
    );
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
