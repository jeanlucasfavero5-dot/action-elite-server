// Modes and bots: deathmatch, bomb rounds, respawn, navigation, and whole matches played by bots only.
//   node --test src/sim/test/match.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeposito } from "../map.ts";
import { Match, DEFAULT_CONFIG, PLANT_TIME, DEFUSE_TIME, FUSE_TIME, FREEZE_TIME, type MatchConfig } from "../match.ts";
import { Bot } from "../bot.ts";
import { IDLE_INPUT, type FighterInput } from "../fighter.ts";
import { Nav } from "../nav.ts";

const map = buildDeposito();
const cfg = (o: Partial<MatchConfig>): MatchConfig => ({ ...DEFAULT_CONFIG, seed: 11, ...o });

/** the human fighter plays as a bot too, so a whole match runs with nobody at the keyboard */
function allBots(m: Match, difficulty = 1): void {
  const f = m.local;
  f.isBot = true;
  m.bots.set(f.id, new Bot(f, m, difficulty));
}
const run = (m: Match, secs: number): void => { for (let i = 0; i < secs * 60; i++) m.tick(1 / 60); };
const press = (m: Match, id: number, inp: Partial<FighterInput>, secs: number): void => { for (let i = 0; i < secs * 60; i++) { m.inputs.set(id, { ...IDLE_INPUT, ...inp }); m.tick(1 / 60); } };

test("nav: paths between the two ends of the yard avoid every solid", () => {
  const nav = new Nav(map);
  for (const [ax, az, bx, bz] of [[0, 19, 0, -15], [-17, 20, 17, -16], [-14, -2, 14, -2], [20, 20, -20, -12]]) {
    const p = nav.path(ax, az, bx, bz);
    assert.ok(p && p.length >= 2, `a path ${ax},${az} -> ${bx},${bz}`);
    for (const pt of p!) assert.ok(nav.isWalkable(...nav.cellOf(pt.x, pt.z)), `waypoint ${pt.x},${pt.z} is walkable`);
    for (let i = 1; i < p!.length; i++) assert.ok(nav.clearLine(p![i - 1], p![i]), "each segment is a clear line");
    const len = p!.reduce((s, q, i) => s + (i ? Math.hypot(q.x - p![i - 1].x, q.z - p![i - 1].z) : 0), 0);
    assert.ok(len < 120, `path length ${len.toFixed(1)}`);
  }
});

test("deathmatch: a kill scores for the team, the victim respawns after 3 s under protection", () => {
  const m = new Match(map, cfg({ mode: "deathmatch", teamSize: 2 }));
  const a = m.fighters.find((f) => f.team === 0 && f.isBot)!, v = m.fighters.find((f) => f.team === 1)!;
  const w = a.weapon;
  m.damage(a, v, 999, "body", { x: 0, y: 1, z: 0 }, w);
  assert.ok(!v.alive && m.score[0] === 1 && a.stats.kills === 1 && v.stats.deaths === 1);
  assert.equal(m.damage(a, v, 50, "body", { x: 0, y: 1, z: 0 }, w), false, "a dead fighter takes no more damage");
  run(m, 2.9); assert.ok(!v.alive, "still dead before 3 s");
  run(m, 0.3); assert.ok(v.alive && v.hp === 100, "respawned");
  assert.ok(!v.hittable, "spawn protection: not hittable");
  assert.equal(m.damage(a, v, 50, "body", { x: 0, y: 1, z: 0 }, w), false);
  run(m, 2.2); assert.ok(v.hittable);
});

test("deathmatch: the kill limit ends the match, the time limit decides by score", () => {
  const m = new Match(map, cfg({ mode: "deathmatch", teamSize: 2, killLimit: 3 }));
  const a = m.fighters.find((f) => f.team === 0 && f.isBot)!;
  let ended = -2; m.ev.matchEnd = (w) => { ended = w; };
  for (const v of m.fighters.filter((f) => f.team === 1)) for (let k = 0; k < 2; k++) { v.hittableNow = true; v.protectedUntil = 0; if (!v.alive) m.spawnFighter(v); v.protectedUntil = 0; m.damage(a, v, 999, "head", { x: 0, y: 1, z: 0 }, a.weapon); }
  assert.equal(m.score[0], 3); assert.equal(m.phase, "over"); assert.equal(ended, 0); assert.equal(m.winner, 0);
  const t = new Match(map, cfg({ mode: "deathmatch", teamSize: 1, timeLimit: 5 }));
  run(t, 5.5);
  assert.equal(t.phase, "over"); assert.equal(t.winner, -1, "no kills: a draw");
});

/** puts the local fighter somewhere */
function place(m: Match, id: number, x: number, z: number): void { const f = m.fighter(id)!; f.body.x = x; f.body.z = z; f.body.y = 0; f.body.vx = f.body.vz = 0; f.body.onGround = true; }

test("bomb: freeze time, plant in a site, the fuse explodes and the attackers win the round", () => {
  const m = new Match(map, cfg({ mode: "bomb", teamSize: 2, roundsToWin: 3 }));
  // nobody fights: the bots stand still; the human attacker (team 0) plants
  for (const b of m.bots.keys()) m.bots.delete(b);
  for (const f of m.fighters) f.isBot = false;
  assert.equal(m.phase, "freeze");
  press(m, 1, { fwd: 1 }, FREEZE_TIME - 0.5); assert.ok(m.local.body.z > 18, "frozen: it did not move");
  run(m, 1);
  assert.equal(m.phase, "live");
  const site = map.sites[0];
  place(m, 1, site.x, site.z);
  press(m, 1, { use: true }, PLANT_TIME - 0.5); assert.equal(m.bomb.state, "none");
  press(m, 1, { use: true }, 0.8);
  assert.equal(m.bomb.state, "planted"); assert.equal(m.bomb.site, site.id);
  const dead = m.fighters.filter((f) => f.team === 1);
  for (const f of dead) place(m, f.id, 22, 22); // the defenders are far from the blast
  place(m, 1, 22, 20);
  let ended = ""; m.ev.roundEnd = (_w, reason) => { ended = reason; };
  run(m, FUSE_TIME + 1);
  assert.equal(m.bomb.state, "exploded"); assert.equal(ended, "exploded");
  assert.equal(m.score[0], 1); assert.equal(m.phase, "intermission");
  run(m, 5.2); assert.equal(m.round, 2); assert.equal(m.phase, "freeze");
});

test("bomb: a defender beside the planted bomb defuses it in 5 s, and defenders win the round", () => {
  const m = new Match(map, cfg({ mode: "bomb", teamSize: 2, roundsToWin: 3 }));
  for (const b of m.bots.keys()) m.bots.delete(b);
  for (const f of m.fighters) f.isBot = false;
  run(m, FREEZE_TIME + 0.2);
  const site = map.sites[1];
  place(m, 1, site.x, site.z);
  press(m, 1, { use: true }, PLANT_TIME + 0.3);
  assert.equal(m.bomb.state, "planted");
  const def = m.fighters.find((f) => f.team === 1)!;
  place(m, def.id, m.bomb.x + 1.5, m.bomb.z);
  place(m, 1, -22, 22);
  press(m, def.id, { use: true }, DEFUSE_TIME - 0.5); assert.equal(m.bomb.state, "planted");
  press(m, def.id, { use: true }, 0.8);
  assert.equal(m.bomb.state, "defused"); assert.equal(m.score[1], 1); assert.equal(m.lastReason, "defused");
});

test("bomb: the round also ends by elimination and by time, and sides swap at the half", () => {
  const m = new Match(map, cfg({ mode: "bomb", teamSize: 2, roundsToWin: 3, roundTime: 20 }));
  for (const b of m.bots.keys()) m.bots.delete(b);
  for (const f of m.fighters) f.isBot = false;
  run(m, FREEZE_TIME + 0.2);
  const killer = m.local;
  for (const v of m.fighters.filter((f) => f.team === 1)) { v.hittableNow = true; m.damage(killer, v, 999, "body", { x: 0, y: 1, z: 0 }, killer.weapon); }
  run(m, 0.1); // the round rules look at the fighters on the next tick
  assert.equal(m.lastReason, "eliminated"); assert.equal(m.score[0], 1);
  run(m, 5.2); assert.equal(m.round, 2);
  run(m, FREEZE_TIME + 20.5); // nobody plants: the defenders win on time
  assert.equal(m.lastReason, "time"); assert.equal(m.score[1], 1);
  assert.equal(m.swapped, false);
  run(m, 5.2); // round 3 starts (maxRounds 5: swap after 2 rounds happened at the start of round 3)
  assert.equal(m.swapped, true, "sides swapped after round 2");
  assert.ok(m.isAttacker(1) && !m.isAttacker(0), "team 1 attacks now");
});

for (const difficulty of [0, 1, 3]) {
  test(`bots only: a team deathmatch at difficulty ${difficulty} runs, bots move, fight and score, nobody gets stuck`, () => {
    const m = new Match(map, cfg({ mode: "deathmatch", teamSize: 4, difficulty, killLimit: 40, timeLimit: 150 }));
    allBots(m, difficulty);
    const start = m.fighters.map((f) => ({ x: f.body.x, z: f.body.z }));
    let shots = 0, hits = 0; m.ev.shot = () => { shots++; }; m.ev.hit = () => { hits++; };
    const travelled = m.fighters.map(() => 0);
    const last = m.fighters.map((f) => ({ x: f.body.x, z: f.body.z }));
    for (let i = 0; i < 150 * 60; i++) {
      m.tick(1 / 60);
      if (i % 30 === 0) m.fighters.forEach((f, k) => { travelled[k] += Math.hypot(f.body.x - last[k].x, f.body.z - last[k].z); last[k] = { x: f.body.x, z: f.body.z }; });
      if (m.phase === "over") break;
    }
    for (const f of m.fighters) assert.ok(Number.isFinite(f.body.x) && Number.isFinite(f.body.y) && Number.isFinite(f.body.z) && Math.abs(f.body.x) <= 24 && Math.abs(f.body.z) <= 24 && f.body.y > -1, `${f.name} in bounds`);
    const kills = m.fighters.reduce((n, f) => n + f.stats.kills, 0);
    assert.ok(kills >= 3, `kills ${kills} in ${m.time.toFixed(0)} s (shots ${shots}, hits ${hits})`);
    assert.equal(m.score[0] + m.score[1], kills, "every kill scored for a team");
    const idle = m.fighters.filter((f, k) => travelled[k] < 15);
    assert.equal(idle.length, 0, `bots that barely moved: ${idle.map((f) => f.name).join(", ")}`);
    void start;
    console.log(`  difficulty ${difficulty}: ${kills} kills in ${m.time.toFixed(0)} s, ${shots} shots, ${hits} hits, score ${m.score.join("-")}`);
  });
}

test("bots only: a whole bomb match ends with a winner, with plants and defuses along the way", () => {
  const m = new Match(map, cfg({ mode: "bomb", teamSize: 4, difficulty: 1, roundsToWin: 3, roundTime: 90 }));
  allBots(m, 1);
  let planted = 0, defused = 0, exploded = 0, rounds = 0; const reasons: string[] = [];
  m.ev.bombPlanted = () => { planted++; }; m.ev.bombDefused = () => { defused++; }; m.ev.bombExploded = () => { exploded++; };
  m.ev.roundEnd = (_w, r) => { rounds++; reasons.push(r); };
  for (let i = 0; i < 60 * 60 * 12 && m.phase !== "over"; i++) m.tick(1 / 60);
  assert.equal(m.phase, "over", `ended after ${m.time.toFixed(0)} s, rounds ${rounds}, ${reasons.join(",")}`);
  assert.ok(m.winner === 0 || m.winner === 1);
  assert.ok(rounds >= 3 && rounds <= 5);
  assert.ok(planted >= 1, `the bomb was planted ${planted} times (${reasons.join(",")})`);
  console.log(`  bomb match: ${rounds} rounds (${reasons.join(", ")}), planted ${planted}, defused ${defused}, exploded ${exploded}, score ${m.score.join("-")}, ${m.time.toFixed(0)} s`);
});
