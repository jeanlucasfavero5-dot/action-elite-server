// The wire protocol shared by the browser and the server: constants, the compact input and snapshot formats, and message shapes.
// Everything travels as JSON over one WebSocket. Gameplay messages use short arrays to keep the traffic small.
import type { FighterInput } from "../sim/fighter.ts";

export const PROTOCOL = 1;
/** simulation ticks per second, on the server and in the browser's prediction */
export const TICK = 60;
/** a snapshot every N ticks (20 per second) */
export const SNAP_EVERY = 3;
/** remote players are drawn this many seconds in the past, between two snapshots */
export const INTERP = 0.1;
export const MAX_ROOM = 16;

// bits of the input flags
export const FL = { jump: 1, sprint: 2, crouch: 4, fire: 8, firePressed: 16, scope: 32, reload: 64, last: 128, use: 256 } as const;

/** one tick of the local player's controls, as sent: [seq, flags, fwd, strafe, yaw, pitch, slot, wheel, viewTimeMs] */
export type WireInput = [number, number, number, number, number, number, number, number, number];

export function packInput(i: FighterInput, seq: number, yaw: number, pitch: number, viewTimeMs: number): WireInput {
  const flags = (i.jump ? FL.jump : 0) | (i.sprint ? FL.sprint : 0) | (i.crouch ? FL.crouch : 0) | (i.fire ? FL.fire : 0) | (i.firePressed ? FL.firePressed : 0)
    | (i.scopePressed ? FL.scope : 0) | (i.reloadPressed ? FL.reload : 0) | (i.lastWeaponPressed ? FL.last : 0) | (i.use ? FL.use : 0);
  return [seq, flags, Math.sign(i.fwd), Math.sign(i.strafe), Math.round(yaw * 1e4) / 1e4, Math.round(pitch * 1e4) / 1e4, i.slot | 0, Math.sign(i.wheel), Math.round(viewTimeMs)];
}

export interface DecodedInput { seq: number; input: FighterInput; yaw: number; pitch: number; viewTime: number }

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** validates and expands a received input; null when it is malformed */
export function unpackInput(a: unknown): DecodedInput | null {
  if (!Array.isArray(a) || a.length < 9 || !a.slice(0, 9).every(fin)) return null;
  const [seq, flags, fwd, strafe, yaw, pitch, slot, wheel, vt] = a as number[];
  if (!Number.isInteger(seq) || seq < 0) return null;
  const has = (b: number) => (flags & b) !== 0;
  return {
    seq,
    yaw: Math.max(-1e4, Math.min(1e4, yaw)), pitch: Math.max(-1.6, Math.min(1.6, pitch)), viewTime: vt,
    input: {
      fwd: Math.max(-1, Math.min(1, Math.round(fwd))), strafe: Math.max(-1, Math.min(1, Math.round(strafe))),
      jump: has(FL.jump), sprint: has(FL.sprint), crouch: has(FL.crouch), fire: has(FL.fire), firePressed: has(FL.firePressed),
      scopePressed: has(FL.scope), reloadPressed: has(FL.reload), lastWeaponPressed: has(FL.last),
      slot: Number.isInteger(slot) && slot >= 0 && slot <= 9 ? slot : 0, wheel: Math.max(-1, Math.min(1, Math.round(wheel))), use: has(FL.use),
    },
  };
}

/** per-fighter row of a snapshot */
export type FRow = [
  id: number, x: number, y: number, z: number, yaw: number, pitch: number, crouch: number, hp: number, flags: number, slot: number,
  vx: number, vz: number, kills: number, deaths: number, headshots: number, score: number, use: number,
];
export const FF = { alive: 1, ground: 2, scoped: 4, reloading: 8 } as const;

/** the state of the local player the server is sure of: [lastInputSeq, x, y, z, vx, vy, vz, onGround, mag, reserve, slot] */
export type YouRow = [number, number, number, number, number, number, number, number, number, number, number];

export interface Snap {
  t: "s";
  /** server match time in seconds */
  time: number;
  /** 0 freeze, 1 live, 2 intermission, 3 over */
  ph: number;
  pl: number;
  clk: number;
  rd: number;
  sc: [number, number];
  sw: number;
  /** bomb: 0 none, 1 planted, 2 defused, 3 exploded; position, seconds left, site */
  bs: number; bx: number; bz: number; bl: number; bsite: string;
  f: FRow[];
  you: YouRow | null;
}

export const PHASES = ["freeze", "live", "intermission", "over"] as const;
export const BOMBS = ["none", "planted", "defused", "exploded"] as const;

export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const r3 = (n: number): number => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- lobby
export interface RoomConfig {
  name: string;
  mode: "deathmatch" | "bomb";
  teamSize: number;
  fillBots: boolean;
  difficulty: number;
  killLimit: number;
  timeLimit: number;
  roundsToWin: number;
  roundTime: number;
  swapSides: boolean;
  friendlyFire: boolean;
}

export const DEFAULT_ROOM: RoomConfig = { name: "Sala", mode: "deathmatch", teamSize: 4, fillBots: true, difficulty: 1, killLimit: 30, timeLimit: 480, roundsToWin: 5, roundTime: 150, swapSides: true, friendlyFire: false };

export interface RoomPlayer { id: number; name: string; team: number; ready: boolean; primary: number; host: boolean }
export interface RoomState { id: number; cfg: RoomConfig; state: "lobby" | "playing"; players: RoomPlayer[] }
export interface RoomListItem { id: number; name: string; mode: string; players: number; max: number; state: string; bots: boolean }

/** sanitizes a room config received from a client */
export function cleanRoomConfig(raw: Partial<RoomConfig> | undefined): RoomConfig {
  const c = { ...DEFAULT_ROOM, ...(raw ?? {}) };
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  return {
    name: String(c.name ?? "Sala").replace(/[<>]/g, "").trim().slice(0, 24) || "Sala",
    mode: c.mode === "bomb" ? "bomb" : "deathmatch",
    teamSize: num(c.teamSize, 1, 8, 4), fillBots: !!c.fillBots, difficulty: num(c.difficulty, 0, 3, 1),
    killLimit: num(c.killLimit, 5, 100, 30), timeLimit: num(c.timeLimit, 60, 1800, 480),
    roundsToWin: num(c.roundsToWin, 1, 8, 5), roundTime: num(c.roundTime, 45, 300, 150), swapSides: !!c.swapSides, friendlyFire: !!c.friendlyFire,
  };
}

export const cleanName = (v: unknown): string => {
  const s = String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 14);
  return s.length >= 2 ? s : "Jogador";
};
