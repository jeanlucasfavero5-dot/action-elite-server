// The in-game overlay: crosshair, hit marker, health, ammo, slots, team score and timer, bomb status, kill feed, banners, damage flash,
// scoreboard (Tab), minimap and the training stats.
import { WEAPONS } from "../sim/weapons.ts";
import type { Match } from "../sim/match.ts";
import { TEAM_NAMES, PLANT_TIME, DEFUSE_TIME } from "../sim/match.ts";
import type { Fighter } from "../sim/fighter.ts";

const TEAM_CSS = ["#5fa0ff", "#ff6a5e"];
const fmtTime = (s: number): string => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface HudState {
  scoreboard: boolean;
  /** the fighter being watched while the player is dead, or null */
  spectating: Fighter | null;
  killedBy: string;
  respawnIn: number;
}

export class Hud {
  readonly root: HTMLElement;
  private cross: HTMLElement;
  private hitm: HTMLElement;
  private hpNum: HTMLElement;
  private hpBar: HTMLElement;
  private name: HTMLElement;
  private ammo: HTMLElement;
  private rl: HTMLElement;
  private rlBar: HTMLElement;
  private slots: HTMLElement[] = [];
  private stats: HTMLElement;
  private feed: HTMLElement;
  private scope: HTMLElement;
  private msg: HTMLElement;
  private fps: HTMLElement;
  private top: HTMLElement;
  private bombEl: HTMLElement;
  private useEl: HTMLElement;
  private useBar: HTMLElement;
  private useLabel: HTMLElement;
  private banner: HTMLElement;
  private hurtEl: HTMLElement;
  private sb: HTMLElement;
  private dead: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private hitTimer = 0;
  private kick = 0;
  private lastKey = "";
  private topKey = "";
  private frames = 0; private fpsT = 0;
  private sbT = 0;
  private hurtT = 0;
  private bannerT = 0;
  private seen = new Map<number, number>();
  private seenT = 0;

  constructor() {
    const r = this.root = document.createElement("div");
    r.id = "ae-hud"; r.className = "ae-layer";
    r.innerHTML = `
      <div id="ae-scope"><i class="h"></i><i class="v"></i></div>
      <div class="ae-hurt"></div>
      <div id="ae-cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="d"></i></div>
      <div id="ae-hitm"><i></i><i></i><i></i><i></i></div>
      <div class="ae-top"></div>
      <div class="ae-bomb"></div>
      <div class="ae-banner"></div>
      <canvas class="ae-mini" width="180" height="180"></canvas>
      <div class="ae-stats"></div>
      <div class="ae-feed"></div>
      <div class="ae-msg"></div>
      <div class="ae-use"><div class="lb"></div><div class="bar"><i></i></div></div>
      <div class="ae-dead"></div>
      <div class="ae-hp"><div class="num">100<small>HP</small></div><div class="bar"><i style="width:100%"></i></div></div>
      <div class="ae-ammo"><div class="ae-slots"></div><div class="name"></div><div class="n"></div><div class="rl"><i></i></div></div>
      <div class="ae-sb"></div>
      <div class="ae-fps"></div>`;
    document.body.appendChild(r);
    const q = <T extends HTMLElement>(s: string) => r.querySelector<T>(s)!;
    this.cross = q("#ae-cross"); this.hitm = q("#ae-hitm"); this.hpNum = q(".ae-hp .num"); this.hpBar = q(".ae-hp .bar i");
    this.name = q(".ae-ammo .name"); this.ammo = q(".ae-ammo .n"); this.rl = q(".ae-ammo .rl"); this.rlBar = q(".ae-ammo .rl i");
    this.stats = q(".ae-stats"); this.feed = q(".ae-feed"); this.scope = q("#ae-scope"); this.msg = q(".ae-msg"); this.fps = q(".ae-fps");
    this.top = q(".ae-top"); this.bombEl = q(".ae-bomb"); this.useEl = q(".ae-use"); this.useBar = q(".ae-use .bar i"); this.useLabel = q(".ae-use .lb");
    this.banner = q(".ae-banner"); this.hurtEl = q(".ae-hurt"); this.sb = q(".ae-sb"); this.dead = q(".ae-dead");
    this.mini = q<HTMLCanvasElement>(".ae-mini"); this.miniCtx = this.mini.getContext("2d")!;
    const sl = q(".ae-slots");
    for (const w of WEAPONS) { const s = document.createElement("span"); s.textContent = `${w.slot}`; s.title = w.name; sl.appendChild(s); this.slots.push(s); }
  }

  show(on: boolean): void { this.root.classList.toggle("on", on); }
  setCrosshairColor(c: string): void { this.cross.style.setProperty("--ch", c); }

  hit(head: boolean, killed: boolean): void {
    this.hitm.className = "on" + (killed ? " kill" : head ? " head" : "");
    this.hitTimer = 0.12;
  }

  popup(x: number, y: number, text: string, head: boolean): void {
    const d = document.createElement("div");
    d.className = "ae-pop" + (head ? " head" : "");
    d.textContent = text; d.style.left = `${x}px`; d.style.top = `${y}px`;
    this.root.appendChild(d);
    setTimeout(() => d.remove(), 720);
  }

  /** a line of the kill feed: killer, weapon, victim */
  feedLine(killer: string, kTeam: number, victim: string, vTeam: number, weapon: string, head: boolean, you: boolean): void {
    const d = document.createElement("div");
    d.className = (head ? "head " : "") + (you ? "you" : "");
    d.innerHTML = `<b style="color:${TEAM_CSS[kTeam] ?? "#ccc"}">${esc(killer)}</b> <span class="w">${esc(weapon)}${head ? " ⌖" : ""}</span> <b style="color:${TEAM_CSS[vTeam] ?? "#ccc"}">${esc(victim)}</b>`;
    this.feed.appendChild(d);
    while (this.feed.children.length > 6) this.feed.firstChild?.remove();
    setTimeout(() => d.remove(), 5000);
  }

  /** a big message in the middle of the top of the screen, with an optional smaller second line */
  say(text: string, color = "#ffffff", ms = 2600, sub = ""): void {
    this.banner.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ""}`; this.banner.style.color = color; this.banner.classList.add("on"); this.bannerT = ms / 1000;
  }

  /** the screen flashes red; `angle` (radians, 0 = from the front) shows where it came from */
  hurt(angle: number | null): void {
    this.hurtT = 0.5;
    this.hurtEl.style.setProperty("--a", angle === null ? "none" : `${angle}rad`);
    this.hurtEl.classList.toggle("dir", angle !== null);
  }

  kickCrosshair(deg: number): void { this.kick = Math.min(24, this.kick + deg * 3); }

  update(m: Match, view: Fighter, dt: number, hFov: number, viewportH: number, st: HudState): void {
    const me = m.local, cfg = m.cfg;
    if (this.hitTimer > 0) { this.hitTimer -= dt; if (this.hitTimer <= 0) this.hitm.className = ""; }
    if (this.hurtT > 0) { this.hurtT -= dt; this.hurtEl.style.opacity = String(Math.max(0, this.hurtT * 2)); } else this.hurtEl.style.opacity = "0";
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.banner.classList.remove("on"); }
    this.kick = Math.max(0, this.kick - dt * 60);
    const w = view.weapon, wst = view.state;
    const dead = !me.alive;

    // crosshair gap follows the real cone
    const pxPerRad = (viewportH / 2) / Math.tan((hFov * Math.PI) / 360);
    const gap = 5 + Math.min(60, Math.tan((view.spreadNow * Math.PI) / 180) * pxPerRad * 0.45 + this.kick);
    const els = this.cross.children;
    (els[0] as HTMLElement).style.top = `${-gap - 9}px`; (els[1] as HTMLElement).style.top = `${gap}px`;
    (els[2] as HTMLElement).style.left = `${-gap - 9}px`; (els[3] as HTMLElement).style.left = `${gap}px`;
    this.cross.style.display = dead || view.scopeFov > 0 || w.kind === "knife" ? "none" : "block";
    this.scope.style.display = view.scopeFov > 0 ? "block" : "none";

    // personal block
    const key = `${view.slot}|${wst.mag}|${wst.reserve}|${Math.round(view.hp)}|${me.stats.kills}|${me.stats.shots}|${me.stats.hits}|${me.stats.headshots}|${me.stats.streak}|${dead}|${view.id}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.hpNum.innerHTML = `${Math.max(0, Math.round(view.hp))}<small>HP</small>`;
      this.hpBar.style.width = `${Math.max(0, view.hp)}%`;
      this.name.textContent = (st.spectating ? `${st.spectating.name} · ` : "") + w.name;
      this.ammo.innerHTML = w.mag ? `${wst.mag}<small>/ ${wst.reserve}</small>` : `<small>—</small>`;
      this.slots.forEach((e, i) => { e.classList.toggle("on", i === view.slot - 1); e.classList.toggle("off", !view.allowed.includes(i + 1)); });
      if (cfg.mode === "training") {
        const acc = me.stats.shots ? Math.round((me.stats.hits / me.stats.shots) * 100) : 0;
        this.stats.innerHTML = `<div><b>Abates</b>${me.stats.kills}</div><div><b>Sequência</b>${me.stats.streak} <span style="opacity:.6">(melhor ${me.stats.bestStreak})</span></div><div><b>Precisão</b>${acc}%</div><div><b>Tiros na cabeça</b>${me.stats.headshots}</div><div><b>Dano total</b>${me.stats.damage}</div>`;
      }
    }
    this.stats.style.display = cfg.mode === "training" ? "block" : "none";
    this.rl.style.display = view.reloading ? "block" : "none";
    if (view.reloading) this.rlBar.style.width = `${Math.round(view.reloadProgress * 100)}%`;

    // messages
    let msg = "";
    if (view.reloading) msg = "Recarregando…";
    else if (w.mag && wst.mag === 0 && wst.reserve === 0) msg = "Sem munição";
    if (!dead && cfg.mode === "bomb" && m.phase === "live") {
      if (m.bomb.state === "none" && m.isAttacker(me.team) && m.map.sites.some((s) => Math.hypot(me.body.x - s.x, me.body.z - s.z) <= s.r)) msg = "Segure E para plantar a bomba";
      else if (m.bomb.state === "planted" && !m.isAttacker(me.team) && Math.hypot(me.body.x - m.bomb.x, me.body.z - m.bomb.z) <= 2.4) msg = "Segure E para desarmar";
    }
    if (!dead && cfg.mode === "bomb" && m.phase === "freeze") msg = `Prepare-se… ${Math.ceil(m.phaseLeft)}`;
    this.msg.textContent = msg;

    // plant / defuse progress
    const using = !dead && me.useProgress > 0;
    this.useEl.style.display = using ? "block" : "none";
    if (using) {
      this.useBar.style.width = `${Math.round(me.useProgress * 100)}%`;
      this.useLabel.textContent = m.bomb.state === "none" ? `Plantando… ${(PLANT_TIME * (1 - me.useProgress)).toFixed(1)} s` : `Desarmando… ${(DEFUSE_TIME * (1 - me.useProgress)).toFixed(1)} s`;
    }

    // top bar
    if (cfg.mode !== "training") {
      const t = fmtTime(m.clock);
      const dots = (team: number) => { let s = ""; for (const f of m.fighters.filter((x) => x.team === team)) s += `<i class="${f.alive ? "on" : ""}"></i>`; return s; };
      const mid = cfg.mode === "bomb" ? `<div class="rd">Rodada ${m.round} · ${m.isAttacker(me.team) ? "ataque" : "defesa"}</div><div class="tm">${m.bomb.state === "planted" ? "💣" : t}</div>` : `<div class="rd">Meta ${cfg.killLimit}</div><div class="tm">${t}</div>`;
      const tk = `${m.score[0]}|${m.score[1]}|${t}|${m.round}|${m.bomb.state}|${m.fighters.map((f) => (f.alive ? 1 : 0)).join("")}|${m.swapped}`;
      if (tk !== this.topKey) {
        this.topKey = tk;
        this.top.innerHTML = `<div class="tb t0"><span class="nm">${TEAM_NAMES[0]}</span><span class="sc">${m.score[0]}</span><span class="dots">${dots(0)}</span></div><div class="mid">${mid}</div><div class="tb t1"><span class="dots">${dots(1)}</span><span class="sc">${m.score[1]}</span><span class="nm">${TEAM_NAMES[1]}</span></div>`;
      }
      this.top.style.display = "flex";
    } else this.top.style.display = "none";
    if (cfg.mode === "bomb" && m.bomb.state === "planted") {
      this.bombEl.style.display = "block";
      this.bombEl.innerHTML = `💣 Bomba plantada no <b>${m.bomb.site}</b> · ${Math.ceil(m.bomb.left)} s`;
      this.bombEl.classList.toggle("urgent", m.bomb.left < 10);
    } else this.bombEl.style.display = "none";

    // death
    this.dead.style.display = dead ? "block" : "none";
    if (dead) {
      const wait = cfg.mode === "deathmatch" ? (st.respawnIn > 0 ? `Renasce em ${Math.ceil(st.respawnIn)} s` : "Renascendo…") : cfg.mode === "bomb" ? "Aguarde a próxima rodada" : "";
      this.dead.innerHTML = `<div class="by">${st.killedBy ? `Abatido por <b>${esc(st.killedBy)}</b>` : "Você morreu"}</div><div class="wt">${wait}</div>${st.spectating ? `<div class="sp">Assistindo ${esc(st.spectating.name)} · clique para trocar</div>` : ""}`;
    }

    // scoreboard
    this.sb.style.display = st.scoreboard || m.phase === "over" ? "block" : "none";
    this.sbT -= dt;
    if ((st.scoreboard || m.phase === "over") && this.sbT <= 0) { this.sbT = 0.25; this.sb.innerHTML = this.scoreboardHtml(m); }

    this.drawMinimap(m, view, dt);

    this.frames++; this.fpsT += dt;
    if (this.fpsT >= 0.5) { this.fps.textContent = `${Math.round(this.frames / this.fpsT)} fps`; this.frames = 0; this.fpsT = 0; }
  }

  scoreboardHtml(m: Match): string {
    const rows = (team: number) => m.fighters.filter((f) => f.team === team).sort((a, b) => b.stats.score - a.stats.score || b.stats.kills - a.stats.kills)
      .map((f) => `<tr class="${f === m.local ? "me" : ""}${f.alive ? "" : " dead"}"><td>${esc(f.name)}</td><td>${f.stats.kills}</td><td>${f.stats.deaths}</td><td>${f.stats.headshots}</td><td>${f.stats.score}</td></tr>`).join("");
    const block = (team: number) => `<table><thead><tr><th style="color:${TEAM_CSS[team]}">${TEAM_NAMES[team]} · ${m.score[team]}</th><th>Abates</th><th>Mortes</th><th>Cabeça</th><th>Pontos</th></tr></thead><tbody>${rows(team)}</tbody></table>`;
    return `<div class="sbc">${block(0)}${block(1)}</div>`;
  }

  private drawMinimap(m: Match, view: Fighter, dt: number): void {
    const c = this.miniCtx, W = this.mini.width, R = W / 2, scale = R / 30;
    this.seenT -= dt;
    if (this.seenT <= 0) {
      this.seenT = 0.15;
      const eye = view.eye, now = m.time;
      for (const e of m.fighters) {
        if (e.team === view.team || !e.alive) continue;
        if (m.nav.see(eye, { x: e.body.x, y: e.body.y + 1.1, z: e.body.z })) this.seen.set(e.id, now);
      }
    }
    c.save();
    c.clearRect(0, 0, W, W);
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.clip();
    c.fillStyle = "rgba(10,14,18,0.78)"; c.fillRect(0, 0, W, W);
    c.translate(R, R); c.rotate(view.yaw); c.scale(scale, scale); c.translate(-view.body.x, -view.body.z);
    c.fillStyle = "rgba(90,98,106,0.9)";
    for (const b of m.map.solids) if (b.y1 > 0.5 && b.y0 < 2 && b.mat !== "floor") c.fillRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
    if (m.cfg.mode === "bomb") {
      c.strokeStyle = "rgba(255,210,60,0.9)"; c.lineWidth = 0.5; c.fillStyle = "rgba(255,210,60,0.9)"; c.font = "bold 5px Arial";
      for (const s of m.map.sites) { c.strokeRect(s.x - s.r, s.z - s.r, s.r * 2, s.r * 2); c.save(); c.translate(s.x, s.z); c.rotate(-view.yaw); c.fillText(s.id, -1.8, 1.8); c.restore(); }
      if (m.bomb.state === "planted") { c.fillStyle = "#ff3030"; c.beginPath(); c.arc(m.bomb.x, m.bomb.z, 1.4, 0, 6.3); c.fill(); }
    }
    for (const f of m.fighters) {
      if (!f.alive || f === view) continue;
      const mate = f.team === view.team;
      if (!mate && m.time - (this.seen.get(f.id) ?? -9) > 1.2) continue;
      c.fillStyle = TEAM_CSS[f.team]; c.beginPath(); c.arc(f.body.x, f.body.z, 1.4, 0, 6.3); c.fill();
    }
    c.restore();
    // the player: an arrow in the middle, and the ring
    c.save(); c.translate(R, R); c.fillStyle = "#ffe28a"; c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 6); c.lineTo(0, 3); c.lineTo(-5, 6); c.closePath(); c.fill(); c.restore();
    c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 2; c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.stroke();
  }
}
