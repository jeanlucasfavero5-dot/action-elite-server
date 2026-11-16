// A fighter seen from outside: a low-poly person in team colors holding its weapon, with a walk cycle, aim, crouch, death fall and a name tag.
import * as THREE from "three";
import type { Fighter } from "../sim/fighter.ts";
import { WEAPONS } from "../sim/weapons.ts";
import { buildModel } from "./viewmodel.ts";

const TEAM_COLOR = [0x2f7bff, 0xe0443a];
const SKINS = [0xd9b08c, 0xc58f69, 0x8d5e3c, 0xf0cba8, 0x6b4630];

const geo = {
  leg: new THREE.BoxGeometry(0.2, 0.78, 0.22), boot: new THREE.BoxGeometry(0.24, 0.1, 0.32), torso: new THREE.BoxGeometry(0.58, 0.66, 0.3),
  arm: new THREE.BoxGeometry(0.15, 0.55, 0.15), head: new THREE.BoxGeometry(0.3, 0.32, 0.3), cap: new THREE.BoxGeometry(0.34, 0.1, 0.34), hand: new THREE.BoxGeometry(0.12, 0.12, 0.12),
  flash: new THREE.PlaneGeometry(0.4, 0.4),
};
const matCache = new Map<number, THREE.MeshStandardMaterial>();
const stdMat = (c: number): THREE.MeshStandardMaterial => {
  let m = matCache.get(c);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, emissive: c, emissiveIntensity: 0.12 }); matCache.set(c, m); }
  return m;
};

let flashMat: THREE.MeshBasicMaterial | null = null;
function flashMaterial(): THREE.MeshBasicMaterial {
  if (flashMat) return flashMat;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, "rgba(255,255,230,1)"); gr.addColorStop(0.4, "rgba(255,190,80,0.8)"); gr.addColorStop(1, "rgba(255,120,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  flashMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  return flashMat;
}

function nameTag(name: string, color: number): THREE.Sprite {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d")!;
  g.font = "bold 30px 'Segoe UI', Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(name, 128, 34);
  g.fillStyle = "#" + color.toString(16).padStart(6, "0"); g.fillText(name, 128, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
  s.scale.set(1.5, 0.375, 1); s.position.y = 2.3; s.renderOrder = 20;
  return s;
}

export class Rig {
  readonly group = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private torso = new THREE.Group();
  private holder = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private tag: THREE.Sprite;
  private flash: THREE.Mesh;
  private models = new Map<number, ReturnType<typeof buildModel>>();
  private slot = -1;
  private phase = Math.random() * 6;
  private tagShown = false;

  constructor(f: Fighter) {
    const vest = stdMat(TEAM_COLOR[f.team] ?? 0x888888), cloth = stdMat(0x3b4048), dark = stdMat(0x23272c), skin = stdMat(SKINS[f.id % SKINS.length]);
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
    this.legL.position.set(-0.13, 0.78, 0); this.legR.position.set(0.13, 0.78, 0);
    for (const leg of [this.legL, this.legR]) { mesh(geo.leg, cloth, 0, -0.39, 0, leg); mesh(geo.boot, dark, 0, -0.73, -0.04, leg); this.group.add(leg); }
    this.torso.position.y = 0.78;
    mesh(geo.torso, vest, 0, 0.34, 0, this.torso);
    mesh(geo.head, skin, 0, 0.86, 0, this.torso);
    mesh(geo.cap, dark, 0, 1.0, 0, this.torso);
    // arms reach forward to the weapon
    this.armR.position.set(0.37, 0.58, 0); this.armR.rotation.set(-1.25, 0, -0.15);
    this.armL.position.set(-0.37, 0.58, 0); this.armL.rotation.set(-1.3, 0, 0.45);
    for (const arm of [this.armR, this.armL]) { mesh(geo.arm, cloth, 0, -0.26, 0, arm); mesh(geo.hand, skin, 0, -0.56, 0, arm); this.torso.add(arm); }
    this.holder.position.set(0.18, 0.44, -0.3);
    this.torso.add(this.holder);
    this.flash = new THREE.Mesh(geo.flash, flashMaterial());
    this.flash.visible = false;
    this.holder.add(this.flash);
    this.group.add(this.torso);
    this.tag = nameTag(f.name, TEAM_COLOR[f.team] ?? 0xffffff);
    this.tag.visible = false;
    this.group.add(this.tag);
  }

  private setWeapon(slot: number): void {
    for (const m of this.models.values()) m.group.visible = false;
    let m = this.models.get(slot);
    if (!m) { m = buildModel(WEAPONS[slot], false); m.group.scale.setScalar(0.95); this.holder.add(m.group); this.models.set(slot, m); }
    m.group.visible = true;
    this.flash.position.copy(m.muzzle.position).multiplyScalar(0.95);
    this.slot = slot;
  }

  /** place and pose the rig for this frame. `showTag`: draw the name tag (teammates). */
  update(f: Fighter, alpha: number, dt: number, showTag: boolean, sinceDeath: number): void {
    const b = f.body, p = f.prev;
    this.group.position.set(p.x + (b.x - p.x) * alpha, p.y + (b.y - p.y) * alpha, p.z + (b.z - p.z) * alpha);
    this.group.rotation.y = f.yaw;
    if (f.slot - 1 !== this.slot) this.setWeapon(f.slot - 1);
    if (f.alive) {
      const sp = f.speed, k = Math.min(1, sp / 5) * (b.onGround ? 1 : 0.2);
      this.phase += dt * (3 + sp * 1.5);
      this.legL.rotation.x = Math.sin(this.phase) * 0.8 * k; this.legR.rotation.x = -Math.sin(this.phase) * 0.8 * k;
      const crouch = b.crouch;
      this.legL.scale.y = this.legR.scale.y = 1 - 0.3 * crouch;
      this.torso.position.y = 0.78 - 0.3 * crouch + Math.abs(Math.sin(this.phase)) * 0.03 * k;
      this.torso.rotation.x = Math.max(-0.7, Math.min(0.7, f.pitch * 0.6));
      this.group.rotation.x = 0;
      this.flash.visible = f.sinceShot < 0.06 && f.weapon.kind !== "knife";
      this.flash.rotation.z = Math.random() * 6.28;
      this.group.visible = true;
    } else {
      this.group.rotation.x = -Math.min(1, sinceDeath / 0.4) * (Math.PI / 2);
      this.flash.visible = false;
      this.group.visible = sinceDeath < 8;
    }
    const show = showTag && f.alive;
    if (show !== this.tagShown) { this.tag.visible = show; this.tagShown = show; }
  }
}
