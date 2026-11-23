// An online match as the browser sees it: a Match that only mirrors the server (remote mode), the local player predicted
// with the same movement rules, the other players interpolated between snapshots, and the server's events turned into the
// same Match events the offline game uses (so the 3D view, HUD and sound do not know the difference).
import type { MapDef } from "../sim/types.ts";
import { Match, DEFAULT_CONFIG, type MatchConfig } from "../sim/match.ts";
import { Fighter, IDLE_INPUT, type FighterInput } from "../sim/fighter.ts";
import { WEAPONS } from "../sim/weapons.ts";
import { rayWorld, type Part } from "../sim/hit.ts";
import * as P from "./protocol.ts";
import type { NetClient } from "./client.ts";

const STEP = 1 / P.TICK;

interface SnapEntry { time: number; rows: Map<number, P.FRow> }
interface Pred { x: number; y: number; z: number }

const PART: Part[] = ["body", "head", "legs"];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpAngle = (a: number, b: number, k: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

export class OnlineSession {
  readonly match: Match;
  readonly net: NetClient;
  readonly localId: number;
  private snaps: SnapEntry[] = [];
  private offset: number | null = null; // server time minus client clock, seconds
  private seq = 0;
  private pred = new Map<number, Pred>();
  private lastBeat = 0;
  /** a message for the screens outside the match (chat, room, back) */
  onLobby: (msg: Record<string, unknown>) => void = () => {};

  constructor(net: NetClient, start: Record<string, unknown>, map: MapDef) {
    this.net = net;
    this.localId = start.you as number;
    const room = start.room as P.RoomConfig;
    const cfg: MatchConfig = {
      ...DEFAULT_CONFIG, mode: room.mode, teamSize: room.teamSize, difficulty: room.difficulty, killLimit: room.killLimit, timeLimit: room.timeLimit,
      roundsToWin: room.roundsToWin, roundTime: room.roundTime, swapSides: room.swapSides, friendlyFire: room.friendlyFire, remote: true,
    };
    this.match = new Match(map, cfg);
    this.match.localId = this.localId;
    for (const f of start.fighters as { id: number; name: string; team: number; bot: boolean }[]) {
      const fighter = new Fighter(f.id, f.name, f.team, f.bot, this.match);
      fighter.alive = false;
      this.match.fighters.push(fighter);
    }
    this.match.time = start.time as number;
  }

  get local(): Fighter { return this.match.fighter(this.localId)!; }

  /** the server's clock now, in seconds of match time */
  serverNow(): number { return this.offset === null ? this.match.time : performance.now() / 1000 + this.offset; }

  // ---------------------------------------------------------------- messages from the server
  handle(msg: Record<string, unknown>): void {
    const m = this.match;
    const fighter = (id: unknown) => m.fighter(id as number);
    switch (msg.t) {
      case "s": this.onSnap(msg as unknown as P.Snap); break;
      case "sh": {
        const f = fighter(msg.id); if (!f) break;
        const o = msg.o as number[], d = msg.d as number[];
        const w = WEAPONS[(msg.w as number) - 1] ?? f.weapon;
        const origin = { x: o[0], y: o[1], z: o[2] }, dir = { x: d[0], y: d[1], z: d[2] };
        const hit = rayWorld(origin, dir, Math.min(w.range, 120), m.solids);
        const t = hit ? hit.t : Math.min(w.range, 120);
        const end = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
        f.sinceShot = 0;
        m.ev.shot(f, { weapon: w, origin, dir, ends: [end], hitTarget: false });
        if (hit) m.ev.impact(end, { x: hit.nx, y: hit.ny, z: hit.nz }, false);
        break;
      }
      case "ht": {
        const v = fighter(msg.v); if (!v) break;
        const pt = msg.pt as number[];
        m.ev.hit(this.local, v, msg.d as number, PART[msg.p as number] ?? "body", !!msg.k, { x: pt[0], y: pt[1], z: pt[2] });
        break;
      }
      case "hu": {
        const a = fighter(msg.a); if (!a) break;
        m.ev.hit(a, this.local, msg.d as number, "body", false, { x: this.local.body.x, y: this.local.body.y + 1, z: this.local.body.z });
        break;
      }
      case "kl": {
        const k = fighter(msg.k), v = fighter(msg.v); if (!k || !v) break;
        v.die(); v.hp = 0; v.deadSince = m.time; v.killedBy = k.id;
        m.ev.kill(k, v, msg.h ? "head" : "body", WEAPONS[(msg.w as number) - 1] ?? k.weapon);
        break;
      }
      case "sp": {
        const f = fighter(msg.id); if (!f) break;
        f.setLoadout(msg.pr as number);
        f.spawn(msg.x as number, msg.y as number, msg.z as number, msg.yaw as number);
        f.deadSince = 0;
        if (f.id === this.localId) { this.pred.clear(); this.lastBeat = 0; }
        m.ev.spawn(f);
        break;
      }
      case "rs": m.round = msg.r as number; m.ev.roundStart(msg.r as number); break;
      case "re": m.lastReason = msg.why as string; m.ev.roundEnd(msg.w as number, msg.why as string); break;
      case "bp": { const f = fighter(msg.id); if (f) m.ev.bombPlanted(msg.s as string, f); break; }
      case "bd": { const f = fighter(msg.id); if (f) m.ev.bombDefused(f); break; }
      case "bx": m.ev.bombExploded(msg.x as number, msg.z as number); break;
      case "bt": m.ev.bombTick(msg.l as number); break;
      case "me": m.winner = msg.w as number; m.phase = "over"; m.ev.matchEnd(msg.w as number); break;
      case "fx": {
        const f = fighter(msg.id); if (!f) break;
        if (msg.k === 1) m.ev.step(f, !!msg.s); else if (msg.k === 2) m.ev.reloadStart(f, f.weapon); else if (msg.k === 3) m.ev.swing(f);
        break;
      }
      default: this.onLobby(msg);
    }
  }

  private onSnap(s: P.Snap): void {
    const m = this.match;
    const raw = s.time - performance.now() / 1000;
    this.offset = this.offset === null ? raw : this.offset * 0.9 + raw * 0.1;
    m.time = s.time;
    m.phase = P.PHASES[s.ph] ?? "live"; m.phaseLeft = s.pl; m.clock = s.clk; m.round = s.rd; m.score = [s.sc[0], s.sc[1]]; m.swapped = !!s.sw;
    m.bomb = { state: P.BOMBS[s.bs] ?? "none", site: s.bsite, x: s.bx, z: s.bz, left: s.bl };
    const rows = new Map<number, P.FRow>();
    for (const r of s.f) {
      rows.set(r[0], r);
      const f = m.fighter(r[0]);
      if (!f) continue;
      const alive = (r[8] & P.FF.alive) !== 0;
      f.hp = r[7]; f.stats.kills = r[12]; f.stats.deaths = r[13]; f.stats.headshots = r[14]; f.stats.score = r[15]; f.useProgress = r[16] / 100;
      if (alive && !f.alive) { f.alive = true; if (f.id !== this.localId) { f.body.x = r[1]; f.body.y = r[2]; f.body.z = r[3]; f.prev = { x: r[1], y: r[2], z: r[3] }; } }
      else if (!alive && f.alive) { f.die(); f.deadSince = m.time; }
      if (f.id !== this.localId) {
        f.slot = r[9] || f.slot;
        f.body.crouch = r[6] / 100; f.body.onGround = (r[8] & P.FF.ground) !== 0;
      }
    }
    this.snaps.push({ time: s.time, rows });
    while (this.snaps.length > 40) this.snaps.shift();
    if (s.you) this.reconcile(s.you);
  }

  /** the server's word on where the local player is: correct the prediction when it drifted */
  private reconcile(y: P.YouRow): void {
    const f = this.local;
    if (!f || !f.alive) return;
    const ack = y[0];
    const p = this.pred.get(ack);
    if (!p || ack === 0) {
      if (ack === 0) return;
    }
    const b = f.body;
    if (p) {
      const ex = y[1] - p.x, ey = y[2] - p.y, ez = y[3] - p.z, err = Math.hypot(ex, ey, ez);
      if (err > 1.5) {
        b.x = y[1]; b.y = y[2]; b.z = y[3]; b.vx = y[4]; b.vy = y[5]; b.vz = y[6]; b.onGround = !!y[7];
        this.pred.clear();
      } else if (err > 0.04) {
        // shift the present, and the recorded future of this correction, by the error so it is not corrected twice
        b.x += ex; b.y += ey; b.z += ez;
        for (const [sq, q] of this.pred) if (sq > ack) { q.x += ex; q.y += ey; q.z += ez; }
      }
      for (const sq of [...this.pred.keys()]) if (sq <= ack) this.pred.delete(sq);
    }
    // the weapon: keep the local prediction unless it is clearly different (a missed reload, a changed gun)
    if (f.slot !== y[10]) { f.slot = y[10]; }
    const st = f.state;
    if (Math.abs(st.mag - y[8]) > 3 || Math.abs(st.reserve - y[9]) > 40) { st.mag = y[8]; st.reserve = y[9]; }
  }

  // ---------------------------------------------------------------- every frame
  /** other players drawn between two snapshots, `INTERP` seconds in the past */
  updateRemote(dt = STEP): void {
    const sn = this.serverNow();
    if (sn > this.match.time) this.match.time = sn; // the clock runs smoothly between snapshots
    for (const f of this.match.fighters) if (f.id !== this.localId) f.sinceShot += dt;
    if (this.snaps.length === 0) return;
    const t = this.serverNow() - P.INTERP;
    const last = this.snaps[this.snaps.length - 1];
    let a = this.snaps[0], b = a;
    if (t >= last.time) { a = b = last; }
    else if (t > this.snaps[0].time) {
      for (let i = this.snaps.length - 1; i > 0; i--) if (this.snaps[i - 1].time <= t) { a = this.snaps[i - 1]; b = this.snaps[i]; break; }
    }
    const k = b.time > a.time ? Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time))) : 1;
    for (const f of this.match.fighters) {
      if (f.id === this.localId) continue;
      const ra = a.rows.get(f.id), rb = b.rows.get(f.id);
      if (!ra || !rb || !f.alive) continue;
      const x = lerp(ra[1], rb[1], k), y = lerp(ra[2], rb[2], k), z = lerp(ra[3], rb[3], k);
      f.body.x = x; f.body.y = y; f.body.z = z; f.prev = { x, y, z };
      f.yaw = lerpAngle(ra[4], rb[4], k); f.pitch = lerp(ra[5], rb[5], k);
      f.body.vx = lerp(ra[10], rb[10], k) / 100; f.body.vz = lerp(ra[11], rb[11], k) / 100;
    }
  }

  /** whether the server will hold the local player still this tick (planting or defusing) */
  private holdsStill(inp: FighterInput): boolean {
    const m = this.match, f = this.local;
    if (!inp.use || m.cfg.mode !== "bomb" || m.phase !== "live") return false;
    if (m.bomb.state === "none" && m.isAttacker(f.team)) return m.map.sites.some((s) => Math.hypot(f.body.x - s.x, f.body.z - s.z) <= s.r) && f.body.onGround;
    if (m.bomb.state === "planted" && !m.isAttacker(f.team)) return Math.hypot(f.body.x - m.bomb.x, f.body.z - m.bomb.z) <= 2.4;
    return false;
  }

  /** one fixed tick of the local player: predict it here and tell the server */
  tick(inp: FighterInput): void {
    const m = this.match, f = this.local;
    if (!f || !f.alive) return;
    const canMove = m.phase !== "freeze" && m.phase !== "over" && !this.holdsStill(inp);
    const seq = ++this.seq;
    this.net.send({ t: "in", i: P.packInput(inp, seq, f.yaw, f.pitch, (this.serverNow() - P.INTERP) * 1000) });
    f.tick(STEP, inp, canMove);
    this.pred.set(seq, { x: f.body.x, y: f.body.y, z: f.body.z });
    if (this.pred.size > 240) this.pred.delete(this.pred.keys().next().value as number);
  }

  /** nothing pressed (paused): keep the server's copy of the player still */
  idleTick(): void { this.tick(IDLE_INPUT); }
}
