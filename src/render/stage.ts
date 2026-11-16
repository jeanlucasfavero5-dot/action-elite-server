// The 3D view: renderer, lights, the map built from its solids, the targets and the player's camera.
import * as THREE from "three";
import type { Box, MapDef, MatKind } from "../sim/types.ts";
import type { Match, Target } from "../sim/match.ts";
import type { Fighter } from "../sim/fighter.ts";
import { makeTextures } from "./textures.ts";
import { buildDummy, poseAvatar, type AvatarView } from "./avatars.ts";
import { Rig } from "./rig.ts";
import { ViewModel } from "./viewmodel.ts";
import { Fx } from "./fx.ts";

const TILE: Partial<Record<MatKind, number>> = { floor: 4, wall: 4, crate: 1.6, "container-red": 2.4, "container-blue": 2.4, "container-green": 2.4, concrete: 2, metal: 1.5, grate: 1 };

/** BoxGeometry whose UVs repeat every `tile` meters, so a big wall and a small crate show the same texel size */
function tiledBox(b: Box, tile: number): THREE.BoxGeometry {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0;
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const sizes: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, (uv.getX(i) * sizes[f][0]) / tile, (uv.getY(i) * sizes[f][1]) / tile);
  }
  return g;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly view = new ViewModel();
  readonly fx: Fx;
  private sun: THREE.DirectionalLight;
  private dummies = new Map<number, AvatarView>();
  private rigs = new Map<number, Rig>();
  private fovNow: number;
  hFov = 90;
  private tmpV = new THREE.Vector3();
  private bombMesh: THREE.Group;
  private bombLed: THREE.Mesh;
  private blast: THREE.Mesh;
  private blastLight: THREE.PointLight;
  private blastT = 0;
  /** camera shake, 0..1 (decays) */
  shake = 0;
  private siteMarks: THREE.Mesh[] = [];

  constructor(private canvas: HTMLCanvasElement, map: MapDef, shadows: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x9db7cf);
    this.scene.fog = new THREE.Fog(0xb4c6d6, 45, 150);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.04, 400);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);
    this.camera.add(this.view.root);
    this.fovNow = this.hFov;

    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5b5348, 1.05));
    this.sun = new THREE.DirectionalLight(0xfff0d2, 1.9);
    this.sun.position.set(-18, 34, 14);
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 5; sc.far = 90;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.setShadows(shadows);

    const T = makeTextures();
    const mats = new Map<MatKind, THREE.MeshStandardMaterial>();
    const matFor = (k: MatKind): THREE.MeshStandardMaterial => {
      let m = mats.get(k);
      if (!m) { m = new THREE.MeshStandardMaterial({ map: T[k] ?? T.concrete, roughness: k === "metal" || k === "grate" ? 0.55 : 0.88, metalness: k === "metal" ? 0.3 : k.startsWith("container") ? 0.15 : 0.05 }); mats.set(k, m); }
      return m;
    };
    for (const b of map.solids) {
      const mesh = new THREE.Mesh(tiledBox(b, TILE[b.mat] ?? 2), matFor(b.mat));
      mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      mesh.castShadow = b.mat !== "floor"; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      this.scene.add(mesh);
    }
    // bomb sites painted on the floor
    for (const s of map.sites) {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const g = c.getContext("2d")!;
      g.strokeStyle = "rgba(255,210,60,0.95)"; g.lineWidth = 10; g.strokeRect(8, 8, 240, 240);
      g.setLineDash([22, 14]); g.lineWidth = 6; g.strokeRect(26, 26, 204, 204);
      g.fillStyle = "rgba(255,210,60,0.9)"; g.font = "bold 150px Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(s.id, 128, 138);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s.r * 2, s.r * 2), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
      m.rotation.x = -Math.PI / 2; m.position.set(s.x, 0.02, s.z); m.visible = false;
      this.scene.add(m); this.siteMarks.push(m);
    }
    // the bomb: a case with a blinking light
    this.bombMesh = new THREE.Group();
    const caseM = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.38), new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.6 }));
    caseM.position.y = 0.14; caseM.castShadow = true;
    this.bombLed = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    this.bombLed.position.set(0.15, 0.3, 0);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: 0xc7a02b, roughness: 0.7 }));
    strap.position.set(-0.12, 0.15, 0);
    this.bombMesh.add(caseM, this.bombLed, strap);
    this.bombMesh.visible = false;
    this.scene.add(this.bombMesh);
    this.blast = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.blast.visible = false;
    this.blastLight = new THREE.PointLight(0xffa050, 0, 40);
    this.scene.add(this.blast, this.blastLight);

    this.fx = new Fx(this.scene);
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  setShadows(on: boolean): void { this.renderer.shadowMap.enabled = on; this.sun.castShadow = on; this.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; }); }

  resize(): void {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov(this.fovNow);
  }

  /** horizontal FOV in degrees -> three's vertical FOV */
  private applyFov(hDeg: number): void {
    const a = this.camera.aspect, hr = (hDeg * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hr / 2) / Math.max(a, 1e-3)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  private dummyView(t: Target): AvatarView {
    let v = this.dummies.get(t.id);
    if (!v) { v = buildDummy(); this.scene.add(v.group); this.dummies.set(t.id, v); }
    return v;
  }

  private rigOf(f: Fighter): Rig {
    let r = this.rigs.get(f.id);
    if (!r) { r = new Rig(f); this.scene.add(r.group); this.rigs.set(f.id, r); }
    return r;
  }

  /** forget the people of the last match */
  clear(): void {
    for (const r of this.rigs.values()) this.scene.remove(r.group);
    this.rigs.clear();
    for (const v of this.dummies.values()) this.scene.remove(v.group);
    this.dummies.clear();
    this.bombMesh.visible = false; this.blast.visible = false; this.blastLight.intensity = 0; this.blastT = 0;
  }

  explode(x: number, z: number): void {
    this.blast.position.set(x, 1.2, z); this.blastLight.position.set(x, 3, z);
    this.blastT = 1.2; this.shake = 1;
    for (let i = 0; i < 14; i++) this.fx.impact({ x: x + (Math.random() - 0.5) * 3, y: 0.4, z: z + (Math.random() - 0.5) * 3 }, { x: (Math.random() - 0.5), y: 1, z: (Math.random() - 0.5) }, false);
  }

  /**
   * camera, people and the bomb for this frame. `view` is the fighter whose eyes the camera takes (the player, or whoever is watched).
   * alpha: how far between the last two ticks.
   */
  update(m: Match, view: Fighter, alpha: number, dt: number, lookDx: number, lookDy: number): void {
    const b = view.body, p = view.prev;
    const x = p.x + (b.x - p.x) * alpha, y = p.y + (b.y - p.y) * alpha, z = p.z + (b.z - p.z) * alpha;
    const sh = this.shake > 0 ? this.shake : 0;
    this.camera.position.set(x + (Math.random() - 0.5) * sh * 0.25, y + view.eyeHeight + (Math.random() - 0.5) * sh * 0.25, z + (Math.random() - 0.5) * sh * 0.25);
    this.camera.rotation.set(view.pitch, view.yaw, 0);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const target = view.scopeFov > 0 ? view.scopeFov : this.hFov;
    this.fovNow += (target - this.fovNow) * Math.min(1, dt * 14);
    this.applyFov(this.fovNow);

    const speed = view.speed;
    this.view.update(dt, view.slot - 1, speed, b.onGround, speed > 6 && view.zoom === 0, view.reloadProgress, view.switching ? 0.4 : 0, view.scopeFov > 0, lookDx, lookDy, b.crouch);
    this.fx.update(dt);

    for (const f of m.fighters) {
      const rig = this.rigOf(f);
      if (f === view) { rig.group.visible = false; continue; }
      rig.update(f, alpha, dt, f.team === m.local.team, m.time - f.deadSince);
    }

    for (const t of m.targets) {
      const v = this.dummyView(t);
      v.group.visible = t.visible && (t.alive || t.sinceDeath < 1.2);
      v.group.position.set(t.x, t.y, t.z);
      v.group.rotation.y = t.yaw;
      poseAvatar(v, t.sinceHit, t.alive, t.sinceDeath, t.hp / 100);
      v.bar.quaternion.copy(v.group.quaternion).invert().multiply(this.camera.quaternion);
    }

    // bomb mode: the sites, the planted bomb
    const bomb = m.cfg.mode === "bomb";
    for (const mk of this.siteMarks) mk.visible = bomb;
    const planted = bomb && m.bomb.state === "planted";
    this.bombMesh.visible = planted;
    if (planted) {
      this.bombMesh.position.set(m.bomb.x, 0, m.bomb.z);
      const urgent = m.bomb.left < 10, period = urgent ? 0.25 : 1;
      (this.bombLed.material as THREE.MeshBasicMaterial).color.setHex(m.bomb.left % period < period * 0.3 ? 0xff2a2a : 0x330606);
    }
    if (this.blastT > 0) {
      this.blastT -= dt;
      const k = 1 - Math.max(0, this.blastT) / 1.2;
      this.blast.visible = this.blastT > 0;
      this.blast.scale.setScalar(1 + k * 11);
      (this.blast.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - k));
      this.blastLight.intensity = Math.max(0, 14 * (1 - k));
    }
  }

  /** screen position (px) of a world point, or null behind the camera */
  project(p: { x: number; y: number; z: number }): { x: number; y: number } | null {
    this.tmpV.set(p.x, p.y, p.z).project(this.camera);
    if (this.tmpV.z > 1) return null;
    return { x: (this.tmpV.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-this.tmpV.y * 0.5 + 0.5) * this.canvas.clientHeight };
  }

  draw(): void { this.renderer.render(this.scene, this.camera); }
}
