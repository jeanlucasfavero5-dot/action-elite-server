// A fighter: a body with a view direction, health, a loadout and the weapon rules (switch, scope, reload, fire, recoil, spread).
// Players, bots and (online) remote players are all fighters, and one `World` (the match) answers who a shot can hit.
import type { Body, Box, MoveCmd, Vec3 } from "./types.ts";
import { WEAPONS, type WeaponDef } from "./weapons.ts";
import { newBody, stepBody } from "./movement.ts";
import { EYE_CROUCH, EYE_STAND, rayBody, rayWorld, type Part } from "./hit.ts";

/** one tick of controls (a player's keys, or a bot's decision) */
export interface FighterInput {
  fwd: number; strafe: number;
  jump: boolean; sprint: boolean; crouch: boolean;
  fire: boolean; firePressed: boolean;
  scopePressed: boolean; reloadPressed: boolean; lastWeaponPressed: boolean;
  /** weapon slot 1..6 picked, or 0 */
  slot: number;
  /** +1 next, -1 previous */
  wheel: number;
  /** held: plant / defuse the bomb */
  use: boolean;
}

export const IDLE_INPUT: FighterInput = { fwd: 0, strafe: 0, jump: false, sprint: false, crouch: false, fire: false, firePressed: false, scopePressed: false, reloadPressed: false, lastWeaponPressed: false, slot: 0, wheel: 0, use: false };

/** anything a shot can hit: a fighter or a training target */
export interface Hittable {
  readonly id: number;
  readonly team: number;
  readonly px: number; readonly py: number; readonly pz: number;
  readonly crouch: number;
  /** alive, visible and not protected from shots */
  readonly hittable: boolean;
}

export interface ShotInfo { weapon: WeaponDef; origin: Vec3; dir: Vec3; ends: Vec3[]; hitTarget: boolean }

export interface FighterFx {
  shot(f: Fighter, i: ShotInfo): void;
  impact(p: Vec3, n: Vec3, onBody: boolean): void;
  empty(f: Fighter): void;
  reloadStart(f: Fighter, w: WeaponDef): void;
  reloadEnd(f: Fighter, w: WeaponDef): void;
  switchTo(f: Fighter, w: WeaponDef): void;
  step(f: Fighter, sprint: boolean): void;
  land(f: Fighter, hard: boolean): void;
  swing(f: Fighter): void;
  scope(f: Fighter, level: number): void;
}

export interface FighterWorld {
  readonly solids: readonly Box[];
  readonly half: number;
  rng(): number;
  /** what this shooter can hit */
  victims(shooter: Fighter): Hittable[];
  /** damage one victim; true when it died */
  damage(shooter: Fighter, victim: Hittable, dmg: number, part: Part, point: Vec3, weapon: WeaponDef): boolean;
  readonly fx: FighterFx;
}

export interface WeaponState { mag: number; reserve: number }

export interface FighterStats { shots: number; hits: number; kills: number; deaths: number; headshots: number; damage: number; streak: number; bestStreak: number; score: number }

const rad = (d: number) => (d * Math.PI) / 180;
const MAX_PITCH = rad(89);

export class Fighter implements Hittable {
  readonly body: Body;
  yaw = 0;
  pitch = 0;
  hp = 100;
  alive = true;
  /** invulnerable until this match time (spawn protection) */
  protectedUntil = 0;
  respawnAt = 0;
  deadSince = 0;
  killedBy = -1;
  /** 1-based slots this fighter may use */
  allowed: number[] = [1, 2, 3, 4, 5, 6];
  weapons: WeaponState[] = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
  slot = 4;
  lastSlot = 2;
  readonly stats: FighterStats = { shots: 0, hits: 0, kills: 0, deaths: 0, headshots: 0, damage: 0, streak: 0, bestStreak: 0, score: 0 };
  /** the previous tick's position (for drawing between ticks) */
  prev = { x: 0, y: 0, z: 0 };
  /** seconds since the last shot (the muzzle flash of other players' guns) */
  sinceShot = 10;
  /** plant / defuse progress 0..1 while the player holds use */
  useProgress = 0;
  /** the main gun slot this fighter asked for (3..6) */
  primary = 4;
  /** seconds to look back when this fighter shoots: lag compensation (online) */
  rewind = 0;

  private cooldown = 0;
  private reloadLeft = 0;
  private switchLeft = 0;
  private zoomLevel = 0;
  private recoilDebt = 0;
  private bloom = 0;
  private stepDist = 0;
  private wasGround = true;
  private fallSpeed = 0;

  readonly id: number;
  name: string;
  team: number;
  isBot: boolean;
  private world: FighterWorld;

  constructor(id: number, name: string, team: number, isBot: boolean, world: FighterWorld, x = 0, z = 0) {
    this.id = id; this.name = name; this.team = team; this.isBot = isBot; this.world = world;
    this.body = newBody(x, 0, z);
    this.prev = { x, y: 0, z };
  }

  // --- Hittable
  get px(): number { return this.body.x; }
  get py(): number { return this.body.y; }
  get pz(): number { return this.body.z; }
  get crouch(): number { return this.body.crouch; }
  hittableNow = true;
  get hittable(): boolean { return this.alive && this.hittableNow; }

  get weapon(): WeaponDef { return WEAPONS[this.slot - 1]; }
  get state(): WeaponState { return this.weapons[this.slot - 1]; }
  get reloading(): boolean { return this.reloadLeft > 0; }
  get reloadProgress(): number { const w = this.weapon; if (!w.mag || this.reloadLeft <= 0) return 0; return 1 - this.reloadLeft / this.reloadTotal(); }
  get switching(): boolean { return this.switchLeft > 0; }
  get zoom(): number { return this.zoomLevel; }
  get scopeFov(): number { return this.zoomLevel > 0 ? this.weapon.zoom[this.zoomLevel - 1] : 0; }
  get eyeHeight(): number { return EYE_STAND + (EYE_CROUCH - EYE_STAND) * this.body.crouch; }
  get moving(): boolean { return Math.hypot(this.body.vx, this.body.vz) > 0.5; }
  get speed(): number { return Math.hypot(this.body.vx, this.body.vz); }
  get eye(): Vec3 { return { x: this.body.x, y: this.body.y + this.eyeHeight, z: this.body.z }; }

  /** gives the loadout and full ammunition; `primary` is the slot of the main gun (3..6) */
  setLoadout(primary: number | null): void {
    this.allowed = primary ? [1, 2, primary] : [1, 2, 3, 4, 5, 6];
    this.weapons = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
    this.slot = primary ?? 4;
    this.lastSlot = 2;
    this.cooldown = 0; this.reloadLeft = 0; this.switchLeft = 0; this.zoomLevel = 0; this.recoilDebt = 0; this.bloom = 0;
  }

  /** put the fighter on the map, alive and at full health */
  spawn(x: number, y: number, z: number, yaw: number): void {
    Object.assign(this.body, { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, crouch: 0 });
    this.prev = { x, y, z };
    this.yaw = yaw; this.pitch = 0;
    this.hp = 100; this.alive = true; this.killedBy = -1; this.useProgress = 0;
    this.stats.streak = 0;
    this.stepDist = 0; this.wasGround = true; this.fallSpeed = 0;
  }

  die(): void { this.alive = false; this.reloadLeft = 0; this.zoomLevel = 0; this.useProgress = 0; this.body.vx = this.body.vz = 0; }

  private reloadTotal(): number {
    const w = this.weapon;
    if (!w.perShellReload) return w.reloadTime;
    return Math.max(1, w.mag - this.state.mag) * w.reloadTime;
  }

  /** view change in radians (mouse) */
  look(dYaw: number, dPitch: number): void {
    this.yaw -= dYaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - dPitch));
  }

  /** a fixed tick */
  tick(dt: number, inp: FighterInput, canMove = true): void {
    if (!this.alive) return;
    this.prev = { x: this.body.x, y: this.body.y, z: this.body.z };
    this.sinceShot += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    this.bloom = Math.max(0, this.bloom - dt * 6);

    this.handleSwitch(inp);
    if (this.switchLeft > 0) { this.switchLeft -= dt; if (this.switchLeft < 0) this.switchLeft = 0; }
    this.handleScope(inp);
    this.handleReload(inp, dt);
    if (canMove) this.handleFire(inp);

    if (this.recoilDebt > 0) {
      const back = Math.min(this.recoilDebt, Math.max(0.02, this.recoilDebt * 5) * dt);
      this.recoilDebt -= back;
      this.pitch = Math.max(-MAX_PITCH, this.pitch - back * 0.6);
    }

    const w = this.weapon;
    const cmd: MoveCmd = {
      fwd: canMove ? inp.fwd : 0, strafe: canMove ? inp.strafe : 0, jump: canMove && inp.jump, sprint: canMove && inp.sprint && !this.reloading && this.zoomLevel === 0, crouch: inp.crouch, yaw: this.yaw,
      speedMult: w.speedMult * (this.zoomLevel > 0 ? 0.6 : 1) * (this.reloading ? 0.9 : 1),
    };
    this.fallSpeed = Math.min(this.fallSpeed, this.body.vy);
    const gx = this.body.x, gz = this.body.z;
    stepBody(this.body, cmd, dt, this.world.solids, this.world.half);
    if (this.body.onGround) {
      this.stepDist += Math.hypot(this.body.x - gx, this.body.z - gz);
      const stride = cmd.sprint ? 2.0 : 2.6;
      if (this.stepDist > stride && this.moving && this.body.crouch < 0.5) { this.stepDist = 0; this.world.fx.step(this, cmd.sprint); }
      if (!this.wasGround) { this.world.fx.land(this, this.fallSpeed < -8); this.fallSpeed = 0; }
    }
    this.wasGround = this.body.onGround;
  }

  private handleSwitch(inp: FighterInput): void {
    let to = 0;
    if (inp.slot >= 1 && inp.slot <= WEAPONS.length && this.allowed.includes(inp.slot)) to = inp.slot;
    else if (inp.lastWeaponPressed && this.allowed.includes(this.lastSlot)) to = this.lastSlot;
    else if (inp.wheel !== 0) {
      const i = this.allowed.indexOf(this.slot);
      to = this.allowed[(i + inp.wheel + this.allowed.length) % this.allowed.length];
    }
    if (to && to !== this.slot) this.switchWeapon(to);
  }

  switchWeapon(to: number): void {
    this.lastSlot = this.slot;
    this.slot = to;
    this.reloadLeft = 0;
    this.zoomLevel = 0;
    this.switchLeft = 0.4;
    this.cooldown = Math.max(this.cooldown, 0.2);
    this.recoilDebt = 0;
    this.world.fx.switchTo(this, this.weapon);
  }

  private handleScope(inp: FighterInput): void {
    if (!inp.scopePressed || this.weapon.zoom.length === 0 || this.switchLeft > 0 || this.reloading) return;
    this.zoomLevel = (this.zoomLevel + 1) % (this.weapon.zoom.length + 1);
    this.world.fx.scope(this, this.zoomLevel);
  }

  startReload(): void {
    const w = this.weapon, st = this.state;
    if (!w.mag || st.mag >= w.mag || st.reserve <= 0 || this.reloading || this.switching) return;
    this.zoomLevel = 0;
    this.reloadLeft = this.reloadTotal();
    this.world.fx.reloadStart(this, w);
  }

  private handleReload(inp: FighterInput, dt: number): void {
    const w = this.weapon, st = this.state;
    if (inp.reloadPressed) this.startReload();
    if (this.reloadLeft <= 0) return;
    if (w.perShellReload) {
      const shellsLeft = Math.ceil(this.reloadLeft / w.reloadTime);
      this.reloadLeft -= dt;
      const shellsNow = Math.ceil(Math.max(0, this.reloadLeft) / w.reloadTime);
      for (let i = shellsLeft; i > shellsNow; i--) if (st.reserve > 0 && st.mag < w.mag) { st.mag++; st.reserve--; }
      if (this.reloadLeft <= 0 || (inp.firePressed && st.mag > 0)) { this.reloadLeft = 0; this.world.fx.reloadEnd(this, w); }
    } else {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        const take = Math.min(w.mag - st.mag, st.reserve);
        st.mag += take; st.reserve -= take;
        this.world.fx.reloadEnd(this, w);
      }
    }
  }

  private handleFire(inp: FighterInput): void {
    const w = this.weapon, st = this.state;
    const wants = w.auto ? inp.fire : inp.firePressed;
    if (!wants || this.cooldown > 0 || this.switching) return;
    if (this.reloading && !(w.perShellReload && st.mag > 0)) return;
    if (w.kind === "knife") { this.cooldown = 60 / w.rpm; this.world.fx.swing(this); this.shoot(w, true); return; }
    if (st.mag <= 0) {
      this.cooldown = 0.25;
      this.world.fx.empty(this);
      this.startReload();
      return;
    }
    st.mag--;
    this.cooldown = 60 / w.rpm;
    this.sinceShot = 0;
    this.shoot(w, false);
    if (st.mag <= 0 && st.reserve > 0 && w.kind !== "sniper") this.startReload();
  }

  /** the cone of the next shot in degrees */
  get spreadNow(): number { return this.spreadDeg(this.weapon); }

  private spreadDeg(w: WeaponDef): number {
    const b = this.body, speed = Math.hypot(b.vx, b.vz);
    let s = w.spread;
    s += w.spreadMove * Math.min(1, speed / 5);
    if (!b.onGround) s += w.spreadAir;
    s *= 1 - 0.3 * b.crouch;
    if (w.kind === "sniper" && this.zoomLevel > 0) s *= speed < 0.5 && b.onGround ? 0 : 1;
    else if (w.kind === "sniper") s += 3;
    if (w.auto) s += this.bloom * 0.35;
    return s;
  }

  private shoot(w: WeaponDef, melee: boolean): void {
    const rng = () => this.world.rng();
    const origin = this.eye;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd: Vec3 = { x: -sy * cp, y: sp, z: -cy * cp };
    const right: Vec3 = { x: cy, y: 0, z: -sy };
    const up: Vec3 = { x: sy * sp, y: cp, z: cy * sp };
    const cone = Math.tan(rad(this.spreadDeg(w)));
    const ends: Vec3[] = [];
    const per = new Map<Hittable, { dmg: number; part: Part; point: Vec3 }>();
    const victims = this.world.victims(this);
    let anyHit = false;

    for (let p = 0; p < w.pellets; p++) {
      const r = cone * Math.sqrt(rng()), a = rng() * Math.PI * 2;
      let dx = fwd.x + right.x * r * Math.cos(a) + up.x * r * Math.sin(a);
      let dy = fwd.y + up.y * r * Math.sin(a);
      let dz = fwd.z + right.z * r * Math.cos(a) + up.z * r * Math.sin(a);
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const dir: Vec3 = { x: dx, y: dy, z: dz };
      const wh = rayWorld(origin, dir, w.range, this.world.solids);
      const maxT = wh ? wh.t : w.range;
      let best: { v: Hittable; part: Part; tt: number; nx: number; ny: number; nz: number } | null = null;
      for (const v of victims) {
        if (!v.hittable) continue;
        const bh = rayBody(origin, dir, best ? best.tt : maxT, v.px, v.py, v.pz, v.crouch);
        if (bh && (!best || bh.hit.t < best.tt)) best = { v, part: bh.part, tt: bh.hit.t, nx: bh.hit.nx, ny: bh.hit.ny, nz: bh.hit.nz };
      }
      if (best) {
        const mult = best.part === "head" ? w.headMult : best.part === "legs" ? w.legMult : 1;
        const fall = best.tt > w.range * 0.5 ? 1 - (1 - w.falloff) * Math.min(1, (best.tt - w.range * 0.5) / (w.range * 0.5)) : 1;
        const dmg = w.damage * mult * fall;
        const pt = { x: origin.x + dx * best.tt, y: origin.y + dy * best.tt, z: origin.z + dz * best.tt };
        ends.push(pt);
        const acc = per.get(best.v);
        if (acc) { acc.dmg += dmg; if (best.part === "head") acc.part = "head"; acc.point = pt; }
        else per.set(best.v, { dmg, part: best.part, point: pt });
        this.world.fx.impact(pt, { x: best.nx, y: best.ny, z: best.nz }, true);
        anyHit = true;
      } else if (wh) {
        const pt = { x: origin.x + dx * wh.t, y: origin.y + dy * wh.t, z: origin.z + dz * wh.t };
        ends.push(pt);
        if (!melee || p === 0) this.world.fx.impact(pt, { x: wh.nx, y: wh.ny, z: wh.nz }, false);
      } else {
        const far = Math.min(w.range, 120);
        ends.push({ x: origin.x + dx * far, y: origin.y + dy * far, z: origin.z + dz * far });
      }
    }

    if (!melee) {
      this.stats.shots++;
      const kick = rad(w.recoilPitch) * (0.8 + rng() * 0.4) * (this.zoomLevel > 0 ? 0.6 : 1) * (1 - 0.25 * this.body.crouch);
      this.pitch = Math.min(MAX_PITCH, this.pitch + kick);
      this.yaw += (rng() - 0.5) * 2 * rad(w.recoilYaw);
      this.recoilDebt += kick;
      this.bloom = Math.min(8, this.bloom + 1);
      this.world.fx.shot(this, { weapon: w, origin, dir: fwd, ends, hitTarget: anyHit });
    }
    if (anyHit) this.stats.hits++;
    for (const [v, h] of per) this.world.damage(this, v, Math.round(h.dmg), h.part, h.point, w);
  }
}
