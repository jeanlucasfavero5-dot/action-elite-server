// The match: fighters (the player, bots, later remote players), a mode with its rules (training, team deathmatch, bomb mission),
// scores, rounds, the bomb and respawns. Pure rules: the browser draws it, the server will run the same class.
import type { MapDef, Vec3 } from "./types.ts";
import type { WeaponDef } from "./weapons.ts";
import { Fighter, IDLE_INPUT, type FighterFx, type FighterInput, type FighterWorld, type Hittable } from "./fighter.ts";
import type { Part } from "./hit.ts";
import { Nav } from "./nav.ts";
import { Bot } from "./bot.ts";

export type ModeId = "training" | "deathmatch" | "bomb";

export interface MatchConfig {
  mode: ModeId;
  /** fighters per team (the player is on team 0) */
  teamSize: number;
  /** 0 easy .. 3 elite */
  difficulty: number;
  /** deathmatch: team kills to win */
  killLimit: number;
  /** deathmatch: match length in seconds */
  timeLimit: number;
  /** bomb: rounds a team needs */
  roundsToWin: number;
  /** bomb: round length in seconds */
  roundTime: number;
  /** bomb: attackers and defenders swap at the half */
  swapSides: boolean;
  friendlyFire: boolean;
  /** slot (3..6) of the player's main gun */
  primary: number;
  playerName: string;
  seed?: number;
}

export const DEFAULT_CONFIG: MatchConfig = { mode: "deathmatch", teamSize: 4, difficulty: 1, killLimit: 30, timeLimit: 480, roundsToWin: 5, roundTime: 150, swapSides: true, friendlyFire: false, primary: 4, playerName: "Jogador" };

export const PLANT_TIME = 3, DEFUSE_TIME = 5, FUSE_TIME = 30, FREEZE_TIME = 4, INTERMISSION = 5, RESPAWN_TIME = 3, PROTECT_TIME = 2, BLAST_RADIUS = 10;
export const TEAM_NAMES = ["Azul", "Vermelho"] as const;

export type TargetKind = "static" | "strafe" | "popup";

/** a training target: a dummy that stands, strafes or pops up */
export class Target implements Hittable {
  readonly team = 9;
  alive = true;
  visible = true;
  hp = 100;
  yaw = 0;
  phase = 0;
  respawnAt = 0;
  sinceHit = 9;
  sinceDeath = 0;
  readonly id: number;
  kind: TargetKind;
  x: number; y: number; z: number;
  homeX: number; homeZ: number;
  constructor(id: number, kind: TargetKind, x: number, y: number, z: number, homeX: number, homeZ: number) {
    this.id = id; this.kind = kind; this.x = x; this.y = y; this.z = z; this.homeX = homeX; this.homeZ = homeZ;
  }
  get px(): number { return this.x; }
  get py(): number { return this.y; }
  get pz(): number { return this.z; }
  get crouch(): number { return 0; }
  get hittable(): boolean { return this.alive && this.visible; }
}

export interface MatchEvents extends FighterFx {
  hit(attacker: Fighter, victim: Fighter | Target, dmg: number, part: Part, killed: boolean, point: Vec3): void;
  kill(attacker: Fighter, victim: Fighter, part: Part, weapon: WeaponDef): void;
  spawn(f: Fighter): void;
  roundStart(round: number): void;
  roundEnd(winner: number, reason: string): void;
  bombPlanted(site: string, planter: Fighter): void;
  bombDefused(defuser: Fighter): void;
  bombExploded(x: number, z: number): void;
  /** once per second while the bomb burns */
  bombTick(left: number): void;
  matchEnd(winner: number): void;
  targetRespawn(t: Target): void;
}

const noop = () => {};
const NO_EVENTS = (): MatchEvents => ({
  shot: noop, impact: noop, empty: noop, reloadStart: noop, reloadEnd: noop, switchTo: noop, step: noop, land: noop, swing: noop, scope: noop,
  hit: noop, kill: noop, spawn: noop, roundStart: noop, roundEnd: noop, bombPlanted: noop, bombDefused: noop, bombExploded: noop, bombTick: noop, matchEnd: noop, targetRespawn: noop,
});

export type Phase = "freeze" | "live" | "intermission" | "over";
export interface Bomb { state: "none" | "planted" | "defused" | "exploded"; site: string; x: number; z: number; left: number }

const BOT_NAMES = ["Falcão", "Corvo", "Lince", "Víbora", "Sombra", "Raio", "Tigre", "Lobo", "Nômade", "Trovão", "Aranha", "Cobra", "Fênix", "Pantera", "Rastro", "Miragem", "Ferrão", "Tufão", "Andorra", "Brasa"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class Match implements FighterWorld {
  readonly map: MapDef;
  readonly solids: MapDef["solids"];
  readonly half: number;
  readonly nav: Nav;
  readonly ev: MatchEvents = NO_EVENTS();
  readonly fighters: Fighter[] = [];
  readonly targets: Target[] = [];
  readonly bots = new Map<number, Bot>();
  /** controls of the human fighters, set by whoever drives them (the browser, or the network) */
  readonly inputs = new Map<number, FighterInput>();
  localId = 1;
  time = 0;
  phase: Phase = "live";
  phaseLeft = 0;
  /** deathmatch: match time left. bomb: round time left. */
  clock = 0;
  round = 0;
  score: [number, number] = [0, 0];
  swapped = false;
  winner = -2; // -2 not decided, -1 draw, 0/1 a team
  bomb: Bomb = { state: "none", site: "", x: 0, z: 0, left: 0 };
  /** why the last round ended (for the banner) */
  lastReason = "";
  private rand: () => number;
  private nextId = 2;
  private nextTargetId = 1;
  private lastBeep = 0;

  readonly cfg: MatchConfig;

  constructor(map: MapDef, cfg: MatchConfig) {
    this.cfg = cfg;
    this.map = map; this.solids = map.solids; this.half = map.half;
    this.rand = cfg.seed !== undefined ? mulberry32(cfg.seed) : Math.random;
    this.nav = new Nav(map);

    const player = new Fighter(1, cfg.playerName, 0, false, this);
    this.fighters.push(player);
    if (cfg.mode === "training") {
      const kinds: TargetKind[] = ["static", "static", "static", "static", "strafe", "strafe", "strafe", "strafe", "popup", "popup"];
      kinds.forEach((k, i) => { const s = map.targetSpots[i % map.targetSpots.length]; this.targets.push(new Target(this.nextTargetId++, k, s.x, s.y, s.z, s.x, s.z)); });
      this.spawnFighter(player);
      this.clock = 0;
      return;
    }
    const names = [...BOT_NAMES];
    for (let t = 0; t < 2; t++) {
      const count = cfg.teamSize - (t === 0 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const name = names.splice(Math.floor(this.rand() * names.length), 1)[0] ?? `Bot${this.nextId}`;
        const f = new Fighter(this.nextId++, name, t, true, this);
        this.fighters.push(f);
        this.bots.set(f.id, new Bot(f, this, cfg.difficulty));
      }
    }
    if (cfg.mode === "deathmatch") {
      this.clock = cfg.timeLimit;
      this.phase = "live";
      for (const f of this.fighters) this.spawnFighter(f);
    } else this.startRound();
  }

  // ---------------------------------------------------------------- queries
  get local(): Fighter { return this.fighters[0]; }
  rng(): number { return this.rand(); }
  fighter(id: number): Fighter | undefined { return this.fighters.find((f) => f.id === id); }
  isAttacker(team: number): boolean { return (team === 0) !== this.swapped; }
  enemiesOf(f: Fighter): Fighter[] { return this.fighters.filter((o) => o.alive && (this.cfg.friendlyFire ? o !== f : o.team !== f.team)); }
  alive(team: number): number { return this.fighters.filter((f) => f.team === team && f.alive).length; }
  get maxRounds(): number { return 2 * this.cfg.roundsToWin - 1; }

  // FighterWorld
  get fx(): FighterFx { return this.proxy; }
  /** the events the fighters raise, forwarded to `ev`; a shot is also heard by the bots */
  private proxy: FighterFx = {
    shot: (f, i) => { for (const b of this.bots.values()) b.hear(f, i.origin); this.ev.shot(f, i); },
    impact: (p, n, onBody) => this.ev.impact(p, n, onBody),
    empty: (f) => this.ev.empty(f),
    reloadStart: (f, w) => this.ev.reloadStart(f, w),
    reloadEnd: (f, w) => this.ev.reloadEnd(f, w),
    switchTo: (f, w) => this.ev.switchTo(f, w),
    step: (f, sprint) => this.ev.step(f, sprint),
    land: (f, hard) => this.ev.land(f, hard),
    swing: (f) => this.ev.swing(f),
    scope: (f, level) => this.ev.scope(f, level),
  };
  victims(shooter: Fighter): Hittable[] {
    const out: Hittable[] = this.fighters.filter((o) => o !== shooter && o.alive && (this.cfg.friendlyFire || o.team !== shooter.team));
    for (const t of this.targets) out.push(t);
    return out;
  }

  damage(shooter: Fighter, victim: Hittable, dmg: number, part: Part, point: Vec3, weapon: WeaponDef): boolean {
    if (victim instanceof Target) {
      if (!victim.alive || !victim.visible) return false;
      victim.hp -= dmg; victim.sinceHit = 0; shooter.stats.damage += dmg;
      const killed = victim.hp <= 0;
      if (killed) {
        victim.alive = false; victim.hp = 0; victim.respawnAt = this.time + 3; victim.sinceDeath = 0;
        shooter.stats.kills++; shooter.stats.streak++; shooter.stats.bestStreak = Math.max(shooter.stats.bestStreak, shooter.stats.streak);
        if (part === "head") shooter.stats.headshots++;
      }
      this.ev.hit(shooter, victim, dmg, part, killed, point);
      return killed;
    }
    const v = victim as Fighter;
    if (!v.alive || !v.hittable || this.phase === "over") return false;
    v.hp -= dmg; shooter.stats.damage += dmg;
    const killed = v.hp <= 0;
    this.ev.hit(shooter, v, dmg, part, killed, point);
    if (killed) {
      v.die(); v.stats.deaths++; v.killedBy = shooter.id; v.deadSince = this.time;
      shooter.stats.kills++; shooter.stats.streak++; shooter.stats.bestStreak = Math.max(shooter.stats.bestStreak, shooter.stats.streak);
      shooter.stats.score += part === "head" ? 15 : 10;
      if (part === "head") shooter.stats.headshots++;
      if (this.cfg.mode === "deathmatch") {
        v.respawnAt = this.time + RESPAWN_TIME;
        if (v.team !== shooter.team) { this.score[shooter.team]++; if (this.score[shooter.team] >= this.cfg.killLimit) this.endMatch(shooter.team); }
      }
      this.ev.kill(shooter, v, part, weapon);
    }
    return killed;
  }

  // ---------------------------------------------------------------- spawning
  /** puts a fighter on a spawn point: the one farthest from the enemies, never on top of someone */
  spawnFighter(f: Fighter, primaryOverride?: number): void {
    const zone = this.cfg.mode === "bomb" ? (this.isAttacker(f.team) ? 0 : 1) : f.team;
    const pts = this.map.spawns.filter((s) => s.team === zone);
    const enemies = this.fighters.filter((o) => o.alive && o.team !== f.team);
    let best = pts[0], bestScore = -1;
    for (const p of pts) {
      if (this.fighters.some((o) => o !== f && o.alive && Math.hypot(o.body.x - p.x, o.body.z - p.z) < 1.6)) continue;
      const d = enemies.length ? Math.min(...enemies.map((e) => Math.hypot(e.body.x - p.x, e.body.z - p.z))) : 30;
      const sc = d + this.rand() * 6;
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    f.setLoadout(primaryOverride ?? this.primaryFor(f));
    f.spawn(best.x, best.y, best.z, best.yaw);
    f.protectedUntil = this.time + (this.cfg.mode === "deathmatch" ? PROTECT_TIME : 0);
    f.hittableNow = true;
    this.bots.get(f.id)?.reset();
    this.ev.spawn(f);
  }

  private primaryFor(f: Fighter): number | null {
    if (this.cfg.mode === "training") return null;
    if (!f.isBot) return this.cfg.primary;
    const r = this.rand(), hard = this.cfg.difficulty;
    if (r < 0.4) return 4;
    if (r < 0.7) return 3;
    if (r < 0.88) return 5;
    return hard === 0 ? 4 : 6;
  }

  // ---------------------------------------------------------------- bomb rounds
  private startRound(): void {
    this.round++;
    this.bomb = { state: "none", site: "", x: 0, z: 0, left: 0 };
    this.phase = "freeze"; this.phaseLeft = FREEZE_TIME;
    this.clock = this.cfg.roundTime;
    for (const f of this.fighters) { f.alive = false; }
    for (const f of this.fighters) this.spawnFighter(f);
    this.ev.roundStart(this.round);
  }

  private endRound(winner: number, reason: string): void {
    if (this.phase !== "live") return;
    this.score[winner]++;
    this.phase = "intermission"; this.phaseLeft = INTERMISSION;
    this.lastReason = reason;
    this.ev.roundEnd(winner, reason);
    if (this.score[winner] >= this.cfg.roundsToWin) { this.endMatch(winner); }
  }

  private endMatch(winner: number): void {
    if (this.phase === "over") return;
    this.phase = "over"; this.winner = winner;
    this.ev.matchEnd(winner);
  }

  private siteAt(f: Fighter) {
    return this.map.sites.find((s) => Math.hypot(f.body.x - s.x, f.body.z - s.z) <= s.r) ?? null;
  }

  /** hold-to-use: plant (attackers, in a site) or defuse (defenders, beside the bomb). True while the fighter must stand still. */
  private handleUse(f: Fighter, input: FighterInput, dt: number): boolean {
    if (this.cfg.mode !== "bomb" || this.phase !== "live" || !f.alive || !input.use) { f.useProgress = 0; return false; }
    if (this.bomb.state === "none" && this.isAttacker(f.team)) {
      const site = this.siteAt(f);
      if (!site || !f.body.onGround) { f.useProgress = 0; return false; }
      f.useProgress += dt / PLANT_TIME;
      if (f.useProgress >= 1) {
        f.useProgress = 0;
        this.bomb = { state: "planted", site: site.id, x: f.body.x, z: f.body.z, left: FUSE_TIME };
        this.lastBeep = FUSE_TIME;
        this.ev.bombPlanted(site.id, f);
        f.stats.score += 25;
      }
      return true;
    }
    if (this.bomb.state === "planted" && !this.isAttacker(f.team)) {
      if (Math.hypot(f.body.x - this.bomb.x, f.body.z - this.bomb.z) > 2.4) { f.useProgress = 0; return false; }
      f.useProgress += dt / DEFUSE_TIME;
      if (f.useProgress >= 1) {
        f.useProgress = 0;
        this.bomb.state = "defused";
        this.ev.bombDefused(f);
        f.stats.score += 25;
        this.endRound(f.team, "defused");
      }
      return true;
    }
    f.useProgress = 0;
    return false;
  }

  private checkRound(dt: number): void {
    const atk = this.cfg.mode === "bomb" ? (this.swapped ? 1 : 0) : 0, def = 1 - atk;
    if (this.bomb.state === "planted") {
      this.bomb.left -= dt;
      if (this.bomb.left < this.lastBeep - 1) { this.lastBeep = Math.ceil(this.bomb.left); this.ev.bombTick(Math.max(0, this.bomb.left)); }
      if (this.bomb.left <= 0) {
        this.bomb.state = "exploded";
        for (const f of this.fighters) if (f.alive && Math.hypot(f.body.x - this.bomb.x, f.body.z - this.bomb.z) < BLAST_RADIUS) { f.hp = 0; f.die(); f.stats.deaths++; }
        this.ev.bombExploded(this.bomb.x, this.bomb.z);
        this.endRound(atk, "exploded");
        return;
      }
    } else {
      this.clock -= dt;
    }
    if (this.phase !== "live") return;
    if (this.alive(def) === 0) { this.endRound(atk, "eliminated"); return; }
    if (this.bomb.state === "none" && this.alive(atk) === 0) { this.endRound(def, "eliminated"); return; }
    if (this.bomb.state === "none" && this.clock <= 0) this.endRound(def, "time");
  }

  // ---------------------------------------------------------------- tick
  tick(dt: number): void {
    this.time += dt;
    const bomb = this.cfg.mode === "bomb";

    // phases
    if (this.phase === "freeze") { this.phaseLeft -= dt; if (this.phaseLeft <= 0) this.phase = "live"; }
    else if (this.phase === "intermission") {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0 && this.phase === "intermission") {
        if (this.cfg.swapSides && this.round === Math.floor(this.maxRounds / 2)) this.swapped = !this.swapped;
        this.startRound();
      }
    }

    const frozen = this.phase === "freeze" || this.phase === "over";
    for (const f of this.fighters) {
      if (!f.alive) continue;
      f.hittableNow = this.time >= f.protectedUntil && !(bomb && this.phase === "freeze");
      const input = f.isBot ? this.bots.get(f.id)!.think(dt) : this.inputs.get(f.id) ?? IDLE_INPUT;
      const busy = this.handleUse(f, input, dt);
      f.tick(dt, input, !frozen && !busy);
    }

    if (this.cfg.mode === "training") this.updateTargets(dt);
    else if (this.cfg.mode === "deathmatch") {
      if (this.phase === "live") {
        for (const f of this.fighters) if (!f.alive && this.time >= f.respawnAt) this.spawnFighter(f);
        this.clock -= dt;
        if (this.clock <= 0) this.endMatch(this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1);
      }
    } else if (this.phase === "live") this.checkRound(dt);
  }

  // ---------------------------------------------------------------- training targets
  private faceYou(t: Target): void { const p = this.local; t.yaw = Math.atan2(-(p.body.x - t.x), -(p.body.z - t.z)); }

  private updateTargets(dt: number): void {
    for (const t of this.targets) {
      t.sinceHit += dt;
      if (!t.alive) {
        t.sinceDeath += dt;
        if (this.time >= t.respawnAt) this.respawnTarget(t);
        continue;
      }
      t.phase += dt;
      if (t.kind === "strafe") { t.x = t.homeX + Math.sin(t.phase * 0.9) * 3.5; this.faceYou(t); }
      else if (t.kind === "popup") { t.visible = t.phase % 4.5 < 2.4; if (t.visible) this.faceYou(t); }
      else this.faceYou(t);
    }
  }

  private respawnTarget(t: Target): void {
    const spots = this.map.targetSpots, spot = spots[Math.floor(this.rand() * spots.length)];
    const kinds: TargetKind[] = ["static", "strafe", "popup"];
    t.kind = kinds[Math.floor(this.rand() * kinds.length)];
    t.x = t.homeX = spot.x; t.z = t.homeZ = spot.z; t.y = spot.y;
    t.hp = 100; t.alive = true; t.visible = true; t.phase = this.rand() * 6.28; t.sinceHit = 9;
    this.faceYou(t);
    this.ev.targetRespawn(t);
  }
}
