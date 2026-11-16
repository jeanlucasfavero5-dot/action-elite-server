// Rules of the Action Elite simulation, without a browser: collision, climbing, shooting, damage, reload.
//   node --test src/sim/test/sim.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeposito } from "../map.ts";
import { newBody, stepBody } from "../movement.ts";
import { rayBox, rayWorld, rayBody } from "../hit.ts";
import { Match, DEFAULT_CONFIG, type Target } from "../match.ts";
import { IDLE_INPUT, type FighterInput } from "../fighter.ts";
import type { MoveCmd } from "../types.ts";

const map = buildDeposito();
const cmd = (o: Partial<MoveCmd>): MoveCmd => ({ fwd: 0, strafe: 0, jump: false, sprint: false, crouch: false, yaw: 0, speedMult: 1, ...o });

function settle(b: ReturnType<typeof newBody>, secs: number): void {
  for (let i = 0; i < secs * 60; i++) stepBody(b, cmd({}), 1 / 60, map.solids, map.half);
}

test("rayBox: distance and face normal", () => {
  const h = rayBox(0, 1, 5, 0, 0, -1, { x0: -1, y0: 0, z0: -1, x1: 1, y1: 2, z1: 1 }, 100)!;
  assert.ok(Math.abs(h.t - 4) < 1e-9 && h.nz === 1 && h.nx === 0 && h.ny === 0);
  assert.equal(rayBox(0, 5, 5, 0, 0, -1, { x0: -1, y0: 0, z0: -1, x1: 1, y1: 2, z1: 1 }, 100), null);
});

test("movement: gravity lands on the floor, the wall stops the player", () => {
  const b = newBody(0, 5, 18);
  settle(b, 2);
  assert.ok(b.onGround && Math.abs(b.y) < 0.01, `landed at y=${b.y}`);
  for (let i = 0; i < 60 * 8; i++) stepBody(b, cmd({ fwd: 1, yaw: Math.PI }), 1 / 60, map.solids, map.half); // yaw PI faces +Z: the south wall
  assert.ok(b.z <= map.half - 0.34 && b.z > map.half - 0.5, `stopped at the wall, z=${b.z}`);
});

test("movement: the catwalk stair climbs to the deck at 3.2 m", () => {
  const b = newBody(21.5, 0, -21);
  settle(b, 1);
  let i = 0;
  while (b.x > 10 && i++ < 60 * 8) stepBody(b, cmd({ fwd: 1, yaw: Math.PI / 2 }), 1 / 60, map.solids, map.half); // yaw PI/2 faces -X
  assert.ok(b.x <= 10 && Math.abs(b.y - 3.2) < 0.05 && b.onGround, `on the deck: x=${b.x.toFixed(2)} y=${b.y.toFixed(2)}`);
});

test("movement: a jump mounts a 1.6 m crate; a 2.6 m container is too high", () => {
  const crate = newBody(-14.5, 0, 14);
  settle(crate, 1);
  let n = 0;
  while (!(crate.onGround && crate.y > 1.5) && n++ < 60 * 3) stepBody(crate, cmd({ fwd: 1, jump: true, yaw: 0 }), 1 / 60, map.solids, map.half);
  assert.ok(crate.onGround && crate.y > 1.5 && crate.y < 1.7, `on top of the first crate: y=${crate.y.toFixed(2)} after ${n} ticks`);
  const cont = newBody(-6, 0, 12);
  settle(cont, 1);
  for (let i = 0; i < 60 * 2; i++) stepBody(cont, cmd({ fwd: 1, jump: true, yaw: 0 }), 1 / 60, map.solids, map.half);
  for (let i = 0; i < 60; i++) stepBody(cont, cmd({}), 1 / 60, map.solids, map.half);
  assert.ok(cont.onGround && cont.y < 0.5, `still on the ground: y=${cont.y.toFixed(2)}`);
});

test("movement: crouching is slower and lowers the body", () => {
  const a = newBody(3, 0, 20); settle(a, 1);
  const b = newBody(10, 0, 20); settle(b, 1);
  for (let i = 0; i < 60; i++) { stepBody(a, cmd({ fwd: 1 }), 1 / 60, map.solids, map.half); stepBody(b, cmd({ fwd: 1, crouch: true }), 1 / 60, map.solids, map.half); }
  assert.ok(b.crouch > 0.95 && 20 - a.z > 20 - b.z + 1, `walked ${20 - a.z} vs crouched ${20 - b.z}`);
});

// ---------------------------------------------------------------- shooting in the training match
const training = (seed = 7) => new Match(map, { ...DEFAULT_CONFIG, mode: "training", seed });
/** one tick with the local fighter's input */
function step(m: Match, inp: Partial<FighterInput> = {}): void { m.inputs.set(1, { ...IDLE_INPUT, ...inp }); m.tick(1 / 60); }

/** a target, and the player standing 8 m from it with nothing in between (no solid, no other target) */
function setup(slot: number, kind: "static" | "strafe" | "popup" = "static") {
  const m = training();
  const f = m.local;
  const t = m.targets.find((x) => x.kind === kind)!;
  t.phase = 0;
  let placed = false;
  for (let k = 0; k < 32 && !placed; k++) {
    const ang = (k / 32) * Math.PI * 2, px = t.x + Math.cos(ang) * 8, pz = t.z + Math.sin(ang) * 8;
    if (Math.abs(px) > 22 || Math.abs(pz) > 22) continue;
    if (map.solids.some((b) => b.y1 > 0.2 && px + 0.5 > b.x0 && px - 0.5 < b.x1 && pz + 0.5 > b.z0 && pz - 0.5 < b.z1)) continue;
    const o = { x: px, y: 1.62, z: pz }, d = { x: (t.x - px) / 8, y: (t.y + 1.1 - 1.62) / 8, z: (t.z - pz) / 8 };
    const l = Math.hypot(d.x, d.y, d.z); d.x /= l; d.y /= l; d.z /= l;
    if (rayWorld(o, d, 9, map.solids)) continue;
    if (m.targets.some((u) => u !== t && rayBody(o, d, 9, u.x, u.y, u.z, 0))) continue;
    if (m.targets.some((u) => u !== t && Math.hypot(u.x - px, u.z - pz) < 1.5)) continue;
    f.body.x = px; f.body.z = pz; f.body.y = 0; f.body.vx = f.body.vz = 0; f.body.onGround = true;
    placed = true;
  }
  assert.ok(placed, "a clear spot to shoot from");
  f.switchWeapon(slot);
  for (let i = 0; i < 40; i++) step(m);
  const aim = (y: number): void => {
    const ex = f.body.x, ey = f.body.y + f.eyeHeight, ez = f.body.z;
    const dx = t.x - ex, dy = t.y + y - ey, dz = t.z - ez;
    f.yaw = Math.atan2(-dx, -dz); f.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  };
  return { m, f, t, aim };
}

test("rifle: 26 per body hit, headshot x2.2, kills in 4 body shots, the kill is counted once", () => {
  const { m, f, t, aim } = setup(4);
  aim(1.1);
  step(m, { fire: true, firePressed: true });
  assert.equal(t.hp, 74); assert.equal(f.stats.hits, 1);
  for (let i = 0; i < 80 && t.alive; i++) { aim(1.1); step(m, { fire: true }); }
  assert.ok(!t.alive && f.stats.kills === 1, `kills=${f.stats.kills} hp=${t.hp}`);
  const h = setup(4);
  h.aim(1.66);
  step(h.m, { fire: true, firePressed: true });
  assert.equal(h.t.hp, 100 - Math.round(26 * 2.2));
});

test("sniper: a body shot kills a 100 hp target in one, a leg shot does 75; the scope zooms", () => {
  const a = setup(6); a.aim(1.1);
  step(a.m, { scopePressed: true });
  assert.equal(a.f.scopeFov, 30);
  step(a.m, { scopePressed: true });
  assert.equal(a.f.scopeFov, 12);
  a.aim(1.1); step(a.m, { firePressed: true });
  assert.ok(!a.t.alive, "one body shot");
  const b = setup(6); b.aim(0.3); step(b.m, { firePressed: true });
  assert.equal(b.t.hp, 25);
});

test("shotgun: pellets spread and add up", () => {
  const { m, f, t, aim } = setup(5);
  aim(1.1);
  step(m, { firePressed: true });
  assert.ok(t.hp < 100 && f.stats.hits === 1, `8 m: hp ${t.hp}`);
  assert.ok(100 - t.hp <= 9 * 10 * 1.6);
});

test("a wall between you and the target blocks the shot", () => {
  const { m, f, t } = setup(4);
  m.solids.push({ x0: f.body.x - 3, y0: 0, z0: f.body.z - 1, x1: f.body.x + 3, y1: 4, z1: f.body.z + 1, mat: "wall" });
  const dx = t.x - f.body.x, dy = t.y + 1.1 - 1.62, dz = t.z - f.body.z;
  f.yaw = Math.atan2(-dx, -dz); f.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  step(m, { fire: true, firePressed: true });
  m.solids.pop();
  assert.equal(t.hp, 100);
});

test("ammo: firing uses the magazine, R reloads from the reserve after the reload time, an empty magazine reloads by itself", () => {
  const { m, f } = setup(4);
  const w = f.weapon;
  for (let i = 0; i < 10; i++) { step(m, { fire: true, firePressed: true }); for (let k = 0; k < 8; k++) step(m); }
  assert.equal(f.state.mag, w.mag - 10);
  step(m, { reloadPressed: true });
  assert.ok(f.reloading);
  for (let i = 0; i < Math.ceil(w.reloadTime * 60) + 2; i++) step(m);
  assert.ok(!f.reloading && f.state.mag === w.mag && f.state.reserve === w.reserve - 10, `mag ${f.state.mag} reserve ${f.state.reserve}`);
  f.state.mag = 1;
  step(m, { fire: true, firePressed: true });
  assert.equal(f.state.mag, 0);
  assert.ok(f.reloading, "empty: reloads");
});

test("switching weapons cancels a reload and takes time", () => {
  const { m, f } = setup(4);
  f.state.mag = 5;
  step(m, { reloadPressed: true });
  assert.ok(f.reloading);
  step(m, { slot: 2 });
  assert.ok(!f.reloading && f.slot === 2 && f.switching);
  const before = f.stats.shots;
  step(m, { firePressed: true });
  assert.equal(f.stats.shots, before, "can not shoot while drawing");
  step(m, { lastWeaponPressed: true });
  assert.equal(f.slot, 4);
});

test("a hidden pop-up target takes no hits, a dead one respawns after 3 s", () => {
  const { m, t, aim } = setup(4, "popup");
  t.visible = false; t.phase = 3;
  aim(1.1);
  step(m, { fire: true, firePressed: true });
  assert.equal(t.hp, 100);
  const k = setup(6); k.aim(1.1);
  step(k.m, { firePressed: true });
  assert.ok(!k.t.alive);
  for (let i = 0; i < 60 * 3.2; i++) step(k.m);
  assert.ok(k.t.alive && k.t.hp === 100, "respawned");
});

test("every target spot, spawn point and bomb site is free of solids", () => {
  assert.ok(map.targetSpots.length >= 10, `${map.targetSpots.length} spots`);
  const blocked = (x: number, z: number, r: number) => map.solids.some((b) => x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && b.y1 > 0.2 && b.y0 < 1.8);
  for (const sp of map.targetSpots) assert.ok(!blocked(sp.x, sp.z, 0.01), `target spot ${sp.x},${sp.z}`);
  assert.equal(map.spawns.filter((s) => s.team === 0).length, 8);
  assert.equal(map.spawns.filter((s) => s.team === 1).length, 8);
  for (const sp of map.spawns) assert.ok(!blocked(sp.x, sp.z, 0.5), `spawn ${sp.x},${sp.z}`);
  for (const s of map.sites) assert.ok(!blocked(s.x, s.z, 1.2), `site ${s.id}`);
});

void ({} as Target);
