// Bot AI: perceives (sight, sound), decides (roam, chase, fight, plant, defend, defuse), and drives its fighter with the same controls a player has.
import type { Fighter, FighterInput } from "./fighter.ts";
import { IDLE_INPUT } from "./fighter.ts";
import type { Match } from "./match.ts";
import type { P2 } from "./nav.ts";
import type { Vec3 } from "./types.ts";
import { WEAPONS } from "./weapons.ts";

interface Level { reaction: number; aimErr: number; turn: number; fov: number; headChance: number; burst: [number, number]; sight: number; hearing: number }
/** easy, normal, hard, elite */
const LEVELS: Level[] = [
  { reaction: 0.75, aimErr: 5.5, turn: 130, fov: 100, headChance: 0.05, burst: [2, 4], sight: 40, hearing: 18 },
  { reaction: 0.45, aimErr: 3.2, turn: 210, fov: 110, headChance: 0.12, burst: [3, 6], sight: 55, hearing: 26 },
  { reaction: 0.28, aimErr: 1.9, turn: 320, fov: 120, headChance: 0.22, burst: [4, 8], sight: 70, hearing: 34 },
  { reaction: 0.15, aimErr: 1.0, turn: 460, fov: 130, headChance: 0.35, burst: [5, 10], sight: 90, hearing: 42 },
];

const rad = (d: number) => (d * Math.PI) / 180;
const wrap = (a: number): number => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export class Bot {
  private lv: Level;
  private enemy: Fighter | null = null;
  private seenFor = 0;       // seconds the current enemy has been in sight
  private lostFor = 99;      // seconds since it was last seen
  private lastSeen: Vec3 | null = null;
  private alert: Vec3 | null = null; // where a shot was heard
  private alertAge = 99;
  private path: P2[] = [];
  private pathIdx = 0;
  private goal: P2 | null = null;
  private repath = 0;
  private thinkT = 0;
  private strafeDir = 1;
  private strafeT = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private aimOff = { yaw: 0, pitch: 0 };
  private aimT = 0;
  private stuckT = 0;
  private lastPos = { x: 0, z: 0 };
  private jumpT = 0;
  private site: string = "";
  private roamT = 0;
  private holdUntil = 0;
  private crouchT = 0;

  private f: Fighter;
  private m: Match;

  constructor(f: Fighter, m: Match, difficulty: number) {
    this.f = f; this.m = m;
    this.lv = LEVELS[Math.max(0, Math.min(3, difficulty))];
  }

  reset(): void {
    this.enemy = null; this.seenFor = 0; this.lostFor = 99; this.lastSeen = null; this.alert = null; this.alertAge = 99;
    this.path = []; this.goal = null; this.burstLeft = 0; this.stuckT = 0; this.site = "";
    this.lastPos = { x: this.f.body.x, z: this.f.body.z };
    this.thinkT = this.m.rng() * 0.3;
  }

  /** a shot was fired somewhere (from Match): bots in earshot turn their attention to it */
  hear(src: Fighter, at: Vec3): void {
    if (src === this.f || src.team === this.f.team || !this.f.alive) return;
    const d = Math.hypot(at.x - this.f.body.x, at.z - this.f.body.z);
    if (d <= this.lv.hearing) { this.alert = { x: at.x, y: at.y, z: at.z }; this.alertAge = 0; }
  }

  think(dt: number): FighterInput {
    const f = this.f, m = this.m;
    if (!f.alive) return IDLE_INPUT;
    const inp: FighterInput = { ...IDLE_INPUT };
    this.alertAge += dt; this.lostFor += dt; this.strafeT -= dt; this.jumpT -= dt; this.roamT -= dt; this.crouchT -= dt; this.aimT -= dt;
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.12 + m.rng() * 0.08; this.perceive(); this.decide(); }

    // fight
    if (this.enemy && this.enemy.alive) this.fight(inp, dt);
    else { this.enemy = null; this.seenFor = 0; }

    // objective use (plant / defuse)
    this.useObjective(inp);

    // movement: follow the path, or hold
    this.move(inp, dt);

    // look: toward the enemy when fighting, else along the way
    this.aim(dt);

    // reload when safe and low
    const w = f.weapon, st = f.state;
    if (w.mag && !f.reloading && st.reserve > 0 && (st.mag === 0 || (!this.enemy && st.mag < w.mag * 0.4))) inp.reloadPressed = true;
    // fall back to the pistol when the main gun is dry
    if (w.mag && st.mag === 0 && st.reserve === 0 && f.allowed.includes(2) && f.slot !== 2) inp.slot = 2;
    return inp;
  }

  // ---------------------------------------------------------------- perception and decisions
  private perceive(): void {
    const f = this.f, m = this.m;
    const eye = f.eye;
    let best: Fighter | null = null, bd = Infinity;
    const fwdx = -Math.sin(f.yaw), fwdz = -Math.cos(f.yaw), cosFov = Math.cos(rad(this.lv.fov / 2));
    for (const e of m.enemiesOf(f)) {
      const dx = e.body.x - eye.x, dz = e.body.z - eye.z, d = Math.hypot(dx, dz);
      if (d > this.lv.sight) continue;
      const dot = d > 0.01 ? (dx * fwdx + dz * fwdz) / d : 1;
      const engaged = this.enemy === e;
      if (dot < cosFov && !(engaged && this.lostFor < 1.5)) continue; // outside the field of view
      const chest = { x: e.body.x, y: e.body.y + 1.1 * (1 - 0.25 * e.body.crouch), z: e.body.z };
      if (!m.nav.see(eye, chest) && !m.nav.see(eye, { x: chest.x, y: e.body.y + 1.6, z: chest.z })) continue;
      if (d < bd) { bd = d; best = e; }
    }
    if (best) {
      if (best !== this.enemy) { this.enemy = best; this.seenFor = 0; this.burstLeft = 0; }
      this.lostFor = 0;
      this.lastSeen = { x: best.body.x, y: best.body.y, z: best.body.z };
    } else if (this.enemy && this.lostFor > 2.5) {
      this.enemy = null;
    }
  }

  private decide(): void {
    const f = this.f, m = this.m;
    // where to go
    let goal: P2 | null = null;
    if (this.enemy && this.lostFor < 0.4) {
      // fighting: keep a sensible distance, do not run at a sniper's face
      const d = Math.hypot(this.enemy.body.x - f.body.x, this.enemy.body.z - f.body.z);
      const w = f.weapon;
      const ideal = w.kind === "sniper" ? 30 : w.kind === "shotgun" ? 6 : w.kind === "smg" ? 12 : 18;
      if (d > ideal + 6) goal = { x: this.enemy.body.x, z: this.enemy.body.z };
      else goal = null; // hold, strafe
    } else if (this.lastSeen && this.lostFor < 4) {
      goal = { x: this.lastSeen.x, z: this.lastSeen.z };
    } else if (this.alert && this.alertAge < 5) {
      goal = { x: this.alert.x, z: this.alert.z };
    } else {
      goal = this.objectiveGoal();
    }
    if (goal && (!this.goal || Math.hypot(goal.x - this.goal.x, goal.z - this.goal.z) > 2.5 || this.repath <= 0)) {
      this.goal = goal;
      this.setPath(goal);
    } else if (!goal) { this.goal = null; this.path = []; }
    this.repath -= 0.15;
  }

  private setPath(goal: P2): void {
    const f = this.f;
    const p = this.m.nav.path(f.body.x, f.body.z, goal.x, goal.z);
    this.path = p ?? [];
    this.pathIdx = p && p.length > 1 ? 1 : 0;
    this.repath = 2.5;
  }

  /** where this bot goes when nothing else is happening: depends on the mode and the side */
  private objectiveGoal(): P2 | null {
    const f = this.f, m = this.m, map = m.map;
    if (m.cfg.mode === "bomb") {
      const attacker = m.isAttacker(f.team);
      if (m.bomb.state === "planted") {
        // defenders retake, attackers guard
        if (!attacker) return { x: m.bomb.x, z: m.bomb.z };
        return this.nearBomb();
      }
      if (attacker) {
        if (!this.site) this.site = this.pickSite();
        const s = map.sites.find((x) => x.id === this.site) ?? map.sites[0];
        const near = Math.hypot(f.body.x - s.x, f.body.z - s.z) <= s.r * 0.6;
        return near ? { x: s.x, z: s.z } : { x: s.x + (m.rng() - 0.5) * 3, z: s.z + (m.rng() - 0.5) * 3 };
      }
      // defenders: hold around a site
      if (!this.site) this.site = this.pickSite();
      const s = map.sites.find((x) => x.id === this.site) ?? map.sites[0];
      if (this.roamT > 0 && this.goal) return this.goal;
      this.roamT = 6 + m.rng() * 6;
      return { x: s.x + (m.rng() - 0.5) * 10, z: s.z + (m.rng() - 0.5) * 8 - 3 };
    }
    // deathmatch: head toward where the enemies are, with some wandering
    if (this.roamT > 0 && this.goal && Math.hypot(this.goal.x - f.body.x, this.goal.z - f.body.z) > 2) return this.goal;
    this.roamT = 5 + m.rng() * 5;
    const foes = m.enemiesOf(f);
    if (foes.length && m.rng() < 0.55) {
      const e = foes[Math.floor(m.rng() * foes.length)];
      return { x: e.body.x + (m.rng() - 0.5) * 8, z: e.body.z + (m.rng() - 0.5) * 8 };
    }
    return m.nav.randomPoint(() => m.rng());
  }

  private pickSite(): string {
    const m = this.m;
    // the team shares a plan: the first bot of the team picks, the others follow with a high chance
    const mates = m.fighters.filter((o) => o.team === this.f.team && o.isBot && o !== this.f);
    for (const o of mates) { const b = m.bots.get(o.id); if (b && b.site && m.rng() < 0.8) return b.site; }
    return m.rng() < 0.5 ? "A" : "B";
  }

  private nearBomb(): P2 {
    const m = this.m;
    return { x: m.bomb.x + (m.rng() - 0.5) * 8, z: m.bomb.z + (m.rng() - 0.5) * 8 };
  }

  // ---------------------------------------------------------------- acting
  private fight(inp: FighterInput, dt: number): void {
    const f = this.f, e = this.enemy!;
    if (this.lostFor > 0.4) return; // out of sight: no shooting
    this.seenFor += dt;
    if (this.seenFor < this.lv.reaction) return; // still reacting
    const eye = f.eye;
    const aimPoint = this.aimPoint(e);
    const dx = aimPoint.x - eye.x, dy = aimPoint.y - eye.y, dz = aimPoint.z - eye.z, d = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, d);
    const off = Math.max(Math.abs(wrap(wantYaw + this.aimOff.yaw - f.yaw)), Math.abs(wantPitch + this.aimOff.pitch - f.pitch));
    const w = f.weapon;
    const inRange = d < Math.min(w.range, this.lv.sight);
    const tol = rad(w.kind === "shotgun" ? 6 : d < 10 ? 4 : 2.2);
    if (!inRange || off > tol) return;
    if (this.burstPause > 0) { this.burstPause -= dt; return; }
    if (f.state.mag <= 0 || f.reloading) return;
    if (w.kind === "knife") { if (d < 1.9) { inp.fire = true; inp.firePressed = true; } return; }
    if (this.burstLeft <= 0) {
      const [lo, hi] = this.lv.burst;
      this.burstLeft = w.auto ? lo + Math.floor(m_rng(this.m) * (hi - lo + 1)) : 1;
    }
    inp.fire = true;
    // semi-automatic guns: a click each time the cooldown allows
    inp.firePressed = true;
    this.burstLeft--;
    if (this.burstLeft <= 0) this.burstPause = (w.auto ? 0.15 : w.kind === "sniper" ? 0.6 : 0.12) + m_rng(this.m) * (0.5 - this.levelIdx() * 0.08);
  }

  private levelIdx(): number { return LEVELS.indexOf(this.lv); }

  private aimPoint(e: Fighter): Vec3 {
    const head = e.body.y + 1.62 * (1 - 0.25 * e.body.crouch);
    const useHead = this.m.rng() < this.lv.headChance && this.f.weapon.kind !== "shotgun";
    // lead a moving target a little
    const lead = this.f.weapon.kind === "sniper" || this.f.weapon.kind === "knife" ? 0.12 : 0.04;
    return { x: e.body.x + e.body.vx * lead, y: useHead ? head : e.body.y + 1.15 * (1 - 0.25 * e.body.crouch), z: e.body.z + e.body.vz * lead };
  }

  private useObjective(inp: FighterInput): void {
    const f = this.f, m = this.m;
    if (m.cfg.mode !== "bomb" || m.phase !== "live") return;
    if (this.enemy && this.lostFor < 0.5) return; // fight first
    if (m.bomb.state === "none" && m.isAttacker(f.team)) {
      const s = m.map.sites.find((x) => Math.hypot(f.body.x - x.x, f.body.z - x.z) <= x.r);
      if (s && (this.site === "" || this.site === s.id || m.rng() < 0.02)) inp.use = true;
    } else if (m.bomb.state === "planted" && !m.isAttacker(f.team)) {
      if (Math.hypot(f.body.x - m.bomb.x, f.body.z - m.bomb.z) <= 2.2) inp.use = true;
    }
  }

  private move(inp: FighterInput, dt: number): void {
    const f = this.f;
    if (inp.use) return; // standing still to plant / defuse
    // where to walk
    let tx = f.body.x, tz = f.body.z, walking = false;
    while (this.pathIdx < this.path.length) {
      const p = this.path[this.pathIdx];
      if (Math.hypot(p.x - f.body.x, p.z - f.body.z) < 0.7) this.pathIdx++;
      else { tx = p.x; tz = p.z; walking = true; break; }
    }
    const fighting = this.enemy && this.lostFor < 0.6;
    let dirx = 0, dirz = 0;
    if (walking) { const d = Math.hypot(tx - f.body.x, tz - f.body.z); dirx = (tx - f.body.x) / d; dirz = (tz - f.body.z) / d; }
    if (fighting) {
      // strafe around the enemy while it is in sight
      if (this.strafeT <= 0) { this.strafeT = 0.5 + this.m.rng() * 1.1; this.strafeDir = this.m.rng() < 0.5 ? -1 : 1; if (this.m.rng() < 0.2) this.crouchT = 0.8; }
      const e = this.enemy!;
      const ex = e.body.x - f.body.x, ez = e.body.z - f.body.z, el = Math.hypot(ex, ez) || 1;
      const sx = -ez / el * this.strafeDir, sz = ex / el * this.strafeDir;
      const sniper = f.weapon.kind === "sniper";
      const k = sniper ? 0.2 : 1;
      dirx = dirx * 0.8 + sx * k; dirz = dirz * 0.8 + sz * k;
      if (this.crouchT > 0 || (sniper && el > 15)) inp.crouch = true;
      walking = walking || !sniper;
    }
    if (!walking && !fighting) return;
    const l = Math.hypot(dirx, dirz);
    if (l < 0.01) return;
    dirx /= l; dirz /= l;
    // to local controls: forward is -Z at yaw 0
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw);
    inp.fwd = -sy * dirx + -cy * dirz;
    inp.strafe = cy * dirx + -sy * dirz;
    inp.sprint = !fighting && walking && this.path.length > 0 && !f.reloading;
    // stuck? try a jump, then a new path
    const moved = Math.hypot(f.body.x - this.lastPos.x, f.body.z - this.lastPos.z);
    this.stuckT += dt;
    if (this.stuckT >= 0.6) {
      if (moved < 0.35 && walking) { inp.jump = true; this.repath = 0; if (this.goal) this.setPath({ x: this.goal.x + (this.m.rng() - 0.5) * 4, z: this.goal.z + (this.m.rng() - 0.5) * 4 }); }
      this.lastPos = { x: f.body.x, z: f.body.z };
      this.stuckT = 0;
    }
  }

  private aim(dt: number): void {
    const f = this.f;
    let wantYaw = f.yaw, wantPitch = 0;
    const fighting = this.enemy && this.lostFor < 0.6;
    if (fighting) {
      const e = this.enemy!, p = this.aimPoint(e), eye = f.eye;
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      wantYaw = Math.atan2(-dx, -dz); wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      if (this.aimT <= 0) { // the aim wobbles: new error every so often
        this.aimT = 0.25 + this.m.rng() * 0.25;
        const err = rad(this.lv.aimErr);
        this.aimOff = { yaw: (this.m.rng() - 0.5) * 2 * err, pitch: (this.m.rng() - 0.5) * 1.4 * err };
      }
      wantYaw += this.aimOff.yaw; wantPitch += this.aimOff.pitch;
    } else if (this.alert && this.alertAge < 1.2 && !this.path.length) {
      const dx = this.alert.x - f.body.x, dz = this.alert.z - f.body.z;
      wantYaw = Math.atan2(-dx, -dz);
    } else if (this.path.length && this.pathIdx < this.path.length) {
      // look where we walk, with a little pitch toward level
      const p = this.path[Math.min(this.pathIdx + 1, this.path.length - 1)];
      wantYaw = Math.atan2(-(p.x - f.body.x), -(p.z - f.body.z));
    }
    const maxTurn = rad(this.lv.turn) * dt;
    const dy = wrap(wantYaw - f.yaw);
    f.yaw += Math.max(-maxTurn, Math.min(maxTurn, dy));
    const dp = wantPitch - f.pitch;
    f.pitch += Math.max(-maxTurn, Math.min(maxTurn, dp));
    f.pitch = Math.max(-1.2, Math.min(1.2, f.pitch));
    void WEAPONS;
  }
}

const m_rng = (m: Match): number => m.rng();
