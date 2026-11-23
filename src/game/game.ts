// The game: wires input, the match (rules and bots), the 3D stage, the HUD, sound, the profile and the menus, and runs the loop.
import * as THREE from "three";
import { Input, type InputFrame } from "../core/input.ts";
import { Sound } from "../core/audio.ts";
import { loadSettings, saveSettings, type Settings } from "../core/settings.ts";
import { loadProfile, saveProfile as saveProfileData, awardMatch, type Profile } from "../core/profile.ts";
import { buildDeposito } from "../sim/map.ts";
import { Match, DEFAULT_CONFIG, TEAM_NAMES, RESPAWN_TIME, type MatchConfig, type Target } from "../sim/match.ts";
import { Bot } from "../sim/bot.ts";
import { IDLE_INPUT, type Fighter, type FighterInput } from "../sim/fighter.ts";
import { Stage } from "../render/stage.ts";
import { Hud } from "../ui/hud.ts";
import { Menus } from "../ui/menus.ts";
import { OnlineUi } from "../ui/online.ts";
import { OnlineSession } from "../net/online.ts";
import type { NetClient } from "../net/client.ts";
import { CSS } from "../ui/style.ts";

const STEP = 1 / 60;
const MOUSE_RAD = 0.0022;
type Mode = "menu" | "playing" | "paused" | "results";

const toInput = (f: InputFrame): FighterInput => ({ fwd: f.fwd, strafe: f.strafe, jump: f.jump, sprint: f.sprint, crouch: f.crouch, fire: f.fire, firePressed: f.firePressed, scopePressed: f.scopePressed, reloadPressed: f.reloadPressed, lastWeaponPressed: f.lastWeaponPressed, slot: f.slot, wheel: f.wheel, use: f.use });

export class Game {
  readonly settings: Settings = loadSettings();
  readonly profile: Profile = loadProfile();
  readonly sound = new Sound();
  readonly input: Input;
  match: Match;
  readonly stage: Stage;
  readonly hud = new Hud();
  readonly menus: Menus;
  readonly onlineUi: OnlineUi;
  /** the online match being played, or null (offline) */
  online: OnlineSession | null = null;
  mode: Mode = "menu";
  cfg: MatchConfig = { ...DEFAULT_CONFIG };
  private canvas: HTMLCanvasElement;
  private map = buildDeposito();
  private acc = 0;
  private last = performance.now();
  private pend: FighterInput | null = null;
  private held: FighterInput = IDLE_INPUT;
  private orbit = 0;
  private muzzle = new THREE.Vector3();
  private lookDx = 0;
  private lookDy = 0;
  private spectateId = -1;
  private killedBy = "";
  private scoreboard = false;
  private startedAt = 0;
  private objective = 0;
  private endAt = 0;
  private lastImpactSound = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    this.sound.volume = this.settings.volume;
    this.input = new Input(canvas);
    this.stage = new Stage(canvas, this.map, this.settings.shadows);
    this.stage.hFov = this.settings.fov;
    this.hud.setCrosshairColor(this.settings.crosshair);
    this.menus = new Menus(this.settings, this.profile, {
      startMatch: (cfg) => void this.startMatch(cfg),
      startTraining: () => void this.startMatch({ ...DEFAULT_CONFIG, mode: "training", playerName: this.profile.name }),
      resume: () => void this.resume(),
      quitToMenu: () => this.quitToMenu(),
      playAgain: () => { if (this.online) this.backToRoom(); else void this.startMatch({ ...this.cfg, seed: undefined }); },
      openOnline: () => void this.onlineUi.open(),
      settingsChanged: (s) => this.applySettings(s),
      nameChanged: (n) => { this.match.local.name = n; this.profile.name = n; this.saveProfile(); },
      click: () => this.sound.ui(),
    });
    this.onlineUi = new OnlineUi({
      playerName: () => this.profile.name,
      onStart: (net, msg) => void this.startOnline(net, msg),
      onBack: () => { this.menus.renderMenu(); this.menus.show("menu"); },
      click: () => this.sound.ui(),
    });
    this.match = this.makeShowcase();
    this.wire(this.match, false);
    this.menus.show("menu");
    this.input.onLockChange = (locked) => { if (!locked && this.mode === "playing") this.pauseGame(); };
    canvas.addEventListener("click", () => { if (this.mode === "paused" && !this.menus.settingsEl.classList.contains("on")) void this.resume(); });
    requestAnimationFrame((t) => this.frame(t));
  }

  private saveProfile(): void { saveProfileData(this.profile); }

  private applySettings(s: Settings): void {
    saveSettings(s);
    this.sound.setVolume(s.volume);
    this.stage.hFov = s.fov;
    this.stage.setShadows(s.shadows);
    this.hud.setCrosshairColor(s.crosshair);
  }

  /** a bots-only deathmatch that plays behind the title screen */
  private makeShowcase(): Match {
    const m = new Match(this.map, { ...DEFAULT_CONFIG, mode: "deathmatch", teamSize: 3, difficulty: 1, killLimit: 999, timeLimit: 99999 });
    m.local.isBot = true;
    m.bots.set(m.local.id, new Bot(m.local, m, 1));
    return m;
  }

  // ---------------------------------------------------------------- who is the camera
  /** the fighter whose eyes we see through: the player, or whoever is watched while the player is dead */
  get viewFighter(): Fighter {
    const m = this.match, me = m.local;
    if (this.mode === "menu" || me.alive) return me;
    let t = m.fighter(this.spectateId);
    if (!t || !t.alive) {
      t = m.fighter(me.killedBy);
      if (!t || !t.alive || t.team !== me.team) t = m.fighters.find((f) => f.alive && f.team === me.team) ?? m.fighters.find((f) => f.alive) ?? me;
      this.spectateId = t.id;
    }
    return t;
  }

  private cycleSpectate(): void {
    const alive = this.match.fighters.filter((f) => f.alive && f !== this.match.local);
    if (!alive.length) return;
    const i = alive.findIndex((f) => f.id === this.spectateId);
    this.spectateId = alive[(i + 1) % alive.length].id;
  }

  // ---------------------------------------------------------------- events -> sound, effects, HUD
  private wire(m: Match, audible: boolean): void {
    const ev = m.ev, st = this.stage, snd = this.sound, hud = this.hud;
    const at = (f: Fighter, play: () => void): void => {
      if (!audible) return;
      const v = this.viewFighter;
      snd.at(f.body.x - v.body.x, f.body.z - v.body.z, v.yaw, play);
    };
    ev.shot = (f, i) => {
      if (f === m.local && audible) {
        snd.shot(i.weapon.kind);
        st.view.fire(i.weapon.kind === "sniper" || i.weapon.kind === "shotgun" ? 1.4 : 0.8);
        hud.kickCrosshair(i.weapon.recoilPitch);
        st.view.muzzleWorld(this.muzzle);
        for (const e of i.ends) st.fx.tracer(this.muzzle, e);
      } else {
        at(f, () => snd.shot(i.weapon.kind));
        this.muzzle.set(i.origin.x + i.dir.x * 0.6, i.origin.y - 0.18 + i.dir.y * 0.6, i.origin.z + i.dir.z * 0.6);
        for (const e of i.ends) st.fx.tracer(this.muzzle, e);
      }
    };
    ev.impact = (p, n, onBody) => {
      st.fx.impact(p, n, onBody);
      const now = performance.now();
      if (audible && now - this.lastImpactSound > 60 && !onBody) { this.lastImpactSound = now; const v = this.viewFighter; snd.at(p.x - v.body.x, p.z - v.body.z, v.yaw, () => snd.impact()); }
    };
    ev.hit = (attacker, victim, dmg, part, killed, point) => {
      if (!audible) return;
      const v = victim as Fighter | Target;
      if (attacker === m.local) {
        snd.hit(part === "head");
        if (killed) snd.kill();
        hud.hit(part === "head", killed);
        const sp = st.project(point);
        if (sp) hud.popup(sp.x, sp.y, `${dmg}`, part === "head");
        if (killed && "kind" in v) hud.feedLine(m.local.name, 0, `Alvo ${v.id}`, 1, attacker.weapon.name, part === "head", true);
      } else if (victim === m.local) {
        snd.hurt();
        // where the shot came from, relative to where the player looks: 0 in front, +90 degrees on the right
        const dx = attacker.body.x - m.local.body.x, dz = attacker.body.z - m.local.body.z, yaw = m.local.yaw;
        hud.hurt(Math.atan2(dx * Math.cos(yaw) - dz * Math.sin(yaw), -dx * Math.sin(yaw) - dz * Math.cos(yaw)));
      }
    };
    ev.kill = (killer, victim, part, weapon) => {
      if (!audible) return;
      hud.feedLine(killer.name, killer.team, victim.name, victim.team, weapon.name, part === "head", killer === m.local);
      if (victim === m.local) { this.killedBy = killer.name; this.spectateId = killer.id; snd.death(); }
      else at(victim, () => snd.land(true));
    };
    ev.empty = (f) => { if (f === m.local && audible) snd.empty(); };
    ev.reloadStart = (f, w) => { if (f === m.local && audible) { if (w.perShellReload) snd.shell(); else snd.reload(); } else at(f, () => snd.reload()); };
    ev.reloadEnd = () => {};
    ev.switchTo = (f) => { if (f === m.local && audible) snd.swap(); };
    ev.step = (f, sprint) => { if (f === m.local && audible) snd.step(sprint); else at(f, () => snd.step(sprint)); };
    ev.land = (f, hard) => { if (f === m.local && audible) snd.land(hard); };
    ev.swing = (f) => { if (f === m.local && audible) { st.view.swingKnife(); snd.shot("knife"); } else at(f, () => snd.shot("knife")); };
    ev.scope = (f) => { if (f === m.local && audible) snd.scope(); };
    ev.spawn = (f) => { if (f === m.local && audible) { this.killedBy = ""; this.spectateId = -1; if (m.time > 1) snd.respawn(); } };
    ev.targetRespawn = () => {};
    ev.roundStart = (round) => {
      if (!audible) return;
      hud.say(`Rodada ${round}`, "#ffe28a"); snd.roundStart();
      if (round > 1 && m.cfg.swapSides && m.swapped !== this.lastSwap) hud.say("Troca de lados!", "#ffe28a");
      this.lastSwap = m.swapped;
    };
    ev.roundEnd = (winner, reason) => {
      if (!audible) return;
      const why = { exploded: "a bomba explodiu", defused: "a bomba foi desarmada", eliminated: "equipe eliminada", time: "o tempo acabou" }[reason] ?? reason;
      hud.say(`${TEAM_NAMES[winner]} venceu a rodada`, winner === 0 ? "#7fb2ff" : "#ff8a80", 3600, why);
      if (winner === m.local.team) snd.roundWin(); else snd.roundLose();
    };
    ev.bombPlanted = (site, planter) => { if (!audible) return; if (planter === m.local) this.objective++; hud.say(`Bomba plantada no ${site}`, "#ff8a80"); snd.plant(); };
    ev.bombDefused = (defuser) => { if (!audible) return; if (defuser === m.local) this.objective++; hud.say("Bomba desarmada", "#7dff9a"); snd.defuse(); };
    ev.bombExploded = (x, z) => { st.explode(x, z); if (audible) snd.explosion(); };
    ev.bombTick = (left) => { if (!audible) return; const v = this.viewFighter; snd.at(m.bomb.x - v.body.x, m.bomb.z - v.body.z, v.yaw, () => snd.beep(left < 10)); };
    ev.matchEnd = (winner) => { if (!audible) return; this.endAt = performance.now() + 2800; hud.say(winner === -1 ? "Empate" : winner === m.local.team ? "Vitória!" : "Derrota", winner === m.local.team ? "#7dff9a" : "#ff8a80", 4000); };
  }
  private lastSwap = false;

  // ---------------------------------------------------------------- flow
  async startMatch(cfg: MatchConfig): Promise<void> {
    this.sound.resume();
    this.cfg = { ...cfg };
    this.stage.clear();
    this.match = new Match(this.map, { ...cfg, playerName: this.profile.name });
    this.wire(this.match, true);
    this.lastSwap = false;
    this.killedBy = ""; this.spectateId = -1; this.objective = 0; this.endAt = 0;
    this.pend = null; this.acc = 0;
    this.startedAt = performance.now();
    this.mode = "playing";
    this.menus.show("none");
    this.hud.show(true);
    this.stage.view.hidden = false;
    this.hud.say(cfg.mode === "training" ? "Treino" : cfg.mode === "bomb" ? "Missão Bomba" : "Deathmatch por equipes", "#ffe28a", 2200);
    await this.input.lock();
    this.guardLock();
  }

  /** the server started the match: mirror it, predict the local player and send the controls */
  async startOnline(net: NetClient, start: Record<string, unknown>): Promise<void> {
    this.sound.resume();
    this.stage.clear();
    const sess = new OnlineSession(net, start, this.map);
    this.online = sess;
    this.match = sess.match;
    this.cfg = { ...sess.match.cfg };
    this.wire(this.match, true);
    net.onMessage = (m) => sess.handle(m);
    sess.onLobby = (m) => this.onlineUi.onMsg(m);
    const prev = net.onStatus;
    net.onStatus = (st) => { prev(st); if (st === "closed" && this.online === sess) this.connectionLost(); };
    this.lastSwap = false;
    this.killedBy = ""; this.spectateId = -1; this.objective = 0; this.endAt = 0;
    this.pend = null; this.acc = 0;
    this.startedAt = performance.now();
    this.mode = "playing";
    this.menus.show("none");
    this.hud.show(true);
    this.stage.view.hidden = false;
    this.hud.say("Partida online", "#ffe28a", 2200);
    await this.input.lock();
    this.guardLock();
  }

  /** the connection dropped during an online match */
  private connectionLost(): void {
    this.hud.say("Conexão com o servidor perdida", "#ff8a80", 3000);
    setTimeout(() => { if (this.online) this.quitToMenu(); }, 2600);
  }

  /** after an online match: the room lobby again */
  private backToRoom(): void {
    const ui = this.onlineUi;
    this.online = null;
    ui.net.onMessage = (m) => ui.onMsg(m);
    this.stage.clear();
    this.match = this.makeShowcase();
    this.wire(this.match, false);
    this.mode = "menu";
    this.hud.show(false);
    this.menus.show("none");
    ui.showRoom();
  }

  private guardLock(): void { setTimeout(() => { if (this.mode === "playing" && !this.input.active) this.pauseGame(); }, 700); }

  private pauseGame(): void {
    this.mode = "paused";
    this.hud.show(true);
    this.menus.show("pause");
  }

  private async resume(): Promise<void> {
    this.sound.resume();
    this.menus.show("none");
    this.mode = "playing";
    await this.input.lock();
    this.guardLock();
  }

  private quitToMenu(): void {
    if (this.online) {
      const ui = this.onlineUi;
      ui.net.send({ t: "leave" });
      this.online = null;
      ui.net.onMessage = (m) => ui.onMsg(m);
    }
    this.input.unlock();
    this.mode = "menu";
    this.stage.clear();
    this.match = this.makeShowcase();
    this.wire(this.match, false);
    this.hud.show(false);
    this.menus.renderMenu();
    this.menus.show("menu");
  }

  private finishMatch(): void {
    const m = this.match, me = m.local;
    this.mode = "results";
    this.input.unlock();
    const won = m.winner === -1 ? null : m.winner === me.team;
    const seconds = (performance.now() - this.startedAt) / 1000;
    const r = awardMatch(this.profile, { mode: m.cfg.mode, won, kills: me.stats.kills, deaths: me.stats.deaths, headshots: me.stats.headshots, shots: me.stats.shots, hits: me.stats.hits, seconds, objective: this.objective, difficulty: m.cfg.difficulty });
    const head = won === null ? "Empate" : won ? "Vitória" : "Derrota";
    const sub = m.cfg.mode === "bomb" ? `Missão Bomba · ${m.score[0]} x ${m.score[1]} em ${m.round} rodadas` : `Deathmatch por equipes · ${m.score[0]} x ${m.score[1]}`;
    this.menus.showResults(won === null ? "draw" : won ? "win" : "lose", head, this.hud.scoreboardHtml(m), r.xp, { before: r.levelBefore, after: r.levelAfter }, sub, !!this.online);
    this.hud.show(false);
  }

  // ---------------------------------------------------------------- loop
  /** an online frame: predict and send the local controls, draw the others between snapshots */
  private frameOnline(now: number, dt: number): void {
    const sess = this.online!, m = this.match, me = sess.local;
    if (!me) return;
    if (this.mode === "playing" && this.input.active) {
      const f = this.input.consume();
      this.scoreboard = f.tab;
      if (me.alive && m.phase !== "over") {
        const zoomScale = me.scopeFov > 0 ? me.scopeFov / this.settings.fov : 1;
        const k = MOUSE_RAD * this.settings.sensitivity * zoomScale;
        me.look(f.lookDx * k, f.lookDy * k * (this.settings.invertY ? -1 : 1));
        this.lookDx = f.lookDx; this.lookDy = f.lookDy;
      } else if (f.firePressed && !me.alive) this.cycleSpectate();
      const cur = toInput(f);
      const p = this.pend;
      this.pend = p ? { ...cur, firePressed: p.firePressed || cur.firePressed, scopePressed: p.scopePressed || cur.scopePressed, reloadPressed: p.reloadPressed || cur.reloadPressed, lastWeaponPressed: p.lastWeaponPressed || cur.lastWeaponPressed, slot: cur.slot || p.slot, wheel: cur.wheel || p.wheel } : cur;
      this.held = cur;
      this.acc += dt;
      while (this.acc >= STEP) {
        const inp = this.pend ?? { ...this.held, firePressed: false, scopePressed: false, reloadPressed: false, lastWeaponPressed: false, slot: 0, wheel: 0 };
        sess.tick(me.alive ? inp : IDLE_INPUT);
        this.pend = null;
        this.acc -= STEP;
      }
    } else {
      // paused: the match goes on, the player stands still
      this.acc += dt;
      while (this.acc >= STEP) { sess.idleTick(); this.acc -= STEP; }
      this.scoreboard = false;
    }
    sess.updateRemote(dt);
    const view = this.viewFighter;
    this.stage.update(m, view, this.acc / STEP, dt, this.lookDx, this.lookDy);
    this.hud.ping = this.onlineUi.net.ping;
    this.hud.update(m, view, dt, this.settings.fov, this.canvas.clientHeight, { scoreboard: this.scoreboard, spectating: view !== me ? view : null, killedBy: this.killedBy, respawnIn: RESPAWN_TIME - (m.time - me.deadSince) });
    if (this.endAt && now >= this.endAt) { this.endAt = 0; this.finishMatch(); }
  }

  private frame(now: number): void {
    // offline a long frame is slowed down; online it is caught up (the server's clock does not wait)
    const dt = Math.min(this.online ? 0.2 : 0.05, (now - this.last) / 1000);
    this.last = now;
    const m = this.match, me = m.local;

    if (this.online && (this.mode === "playing" || this.mode === "paused")) {
      this.frameOnline(now, dt);
      this.stage.draw();
      requestAnimationFrame((t) => this.frame(t));
      return;
    }

    if (this.mode === "playing" && this.input.active) {
      const f = this.input.consume();
      this.scoreboard = f.tab;
      const view = this.viewFighter;
      if (me.alive && m.phase !== "over") {
        // mouse look every frame, not per tick; slower while scoped
        const zoomScale = me.scopeFov > 0 ? me.scopeFov / this.settings.fov : 1;
        const k = MOUSE_RAD * this.settings.sensitivity * zoomScale;
        me.look(f.lookDx * k, f.lookDy * k * (this.settings.invertY ? -1 : 1));
        this.lookDx = f.lookDx; this.lookDy = f.lookDy;
      } else if (f.firePressed && !me.alive) this.cycleSpectate();
      // pending input: an edge (a click) is never lost when no tick runs this frame
      const cur = toInput(f);
      const p = this.pend;
      this.pend = p ? { ...cur, firePressed: p.firePressed || cur.firePressed, scopePressed: p.scopePressed || cur.scopePressed, reloadPressed: p.reloadPressed || cur.reloadPressed, lastWeaponPressed: p.lastWeaponPressed || cur.lastWeaponPressed, slot: cur.slot || p.slot, wheel: cur.wheel || p.wheel } : cur;
      this.held = cur;
      this.acc += dt;
      while (this.acc >= STEP) {
        const inp = this.pend ?? { ...this.held, firePressed: false, scopePressed: false, reloadPressed: false, lastWeaponPressed: false, slot: 0, wheel: 0 };
        m.inputs.set(me.id, me.alive ? inp : IDLE_INPUT);
        m.tick(STEP);
        this.pend = null;
        this.acc -= STEP;
      }
      this.stage.update(m, view, this.acc / STEP, dt, this.lookDx, this.lookDy);
      this.hud.update(m, view, dt, this.settings.fov, this.canvas.clientHeight, { scoreboard: this.scoreboard, spectating: view !== me ? view : null, killedBy: this.killedBy, respawnIn: me.respawnAt - m.time });
      if (this.endAt && now >= this.endAt) { this.endAt = 0; this.finishMatch(); }
    } else if (this.mode === "paused") {
      const view = this.viewFighter;
      this.stage.update(m, view, 1, dt, 0, 0);
      this.hud.update(m, view, dt, this.settings.fov, this.canvas.clientHeight, { scoreboard: false, spectating: view !== me ? view : null, killedBy: this.killedBy, respawnIn: me.respawnAt - m.time });
    } else if (this.mode === "results") {
      this.stage.update(m, me, 1, dt, 0, 0);
    } else if (this.mode === "playing") {
      // waiting for the pointer lock: show the world, do not run it
      const view = this.viewFighter;
      this.stage.update(m, view, 1, dt, 0, 0);
      this.hud.update(m, view, dt, this.settings.fov, this.canvas.clientHeight, { scoreboard: false, spectating: view !== me ? view : null, killedBy: this.killedBy, respawnIn: me.respawnAt - m.time });
    } else {
      // title screen: a bots-only match plays and the camera flies around the yard
      m.tick(Math.min(dt, STEP * 2));
      this.orbit += dt * 0.12;
      this.stage.update(m, me, 1, dt, 0, 0);
      const r = 30;
      this.stage.camera.position.set(Math.sin(this.orbit) * r, 13, Math.cos(this.orbit) * r);
      this.stage.camera.lookAt(0, 1.5, 0);
      this.stage.view.root.visible = false;
    }
    this.stage.draw();
    requestAnimationFrame((t) => this.frame(t));
  }
}
