// Title screen, offline room setup, profile, pause, settings and the match results.
import type { Settings } from "../core/settings.ts";
import { levelInfo, rankName, type Profile } from "../core/profile.ts";
import { DEFAULT_CONFIG, type MatchConfig, type ModeId } from "../sim/match.ts";

export interface MenuActions {
  startMatch(cfg: MatchConfig): void;
  startTraining(): void;
  resume(): void;
  quitToMenu(): void;
  playAgain(): void;
  settingsChanged(s: Settings): void;
  nameChanged(name: string): void;
  openOnline(): void;
  click(): void;
}

declare const __GAME_VERSION__: string;
const ROOM_KEY = "action-elite.room.v1";
const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function loadRoom(): MatchConfig {
  try { const raw = localStorage.getItem(ROOM_KEY); if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<MatchConfig>), seed: undefined }; } catch { /* blocked */ }
  return { ...DEFAULT_CONFIG };
}
function saveRoom(c: MatchConfig): void { try { localStorage.setItem(ROOM_KEY, JSON.stringify({ ...c, seed: undefined })); } catch { /* ignore */ } }

type Which = "menu" | "setup" | "profile" | "pause" | "results" | "none";

export class Menus {
  readonly menu: HTMLElement;
  readonly setup: HTMLElement;
  readonly profileEl: HTMLElement;
  readonly pause: HTMLElement;
  readonly settingsEl: HTMLElement;
  readonly results: HTMLElement;
  private ver: HTMLElement;
  room: MatchConfig = loadRoom();
  private settings: Settings;
  private profile: Profile;
  private act: MenuActions;

  constructor(settings: Settings, profile: Profile, act: MenuActions) {
    this.settings = settings; this.profile = profile; this.act = act;
    this.menu = this.layer("ae-menu", "");
    this.setup = this.layer("ae-setup", "");
    this.setup.style.cssText = "align-items:center;justify-content:center;background:rgba(0,0,0,.72);z-index:22";
    this.profileEl = this.layer("ae-profile", "");
    this.profileEl.style.cssText = "align-items:center;justify-content:center;background:rgba(0,0,0,.72);z-index:22";
    this.pause = this.layer("ae-pause", `
      <div class="ae-card">
        <div class="ae-logo" style="font-size:30px">Pausado</div>
        <div class="ae-btns">
          <button class="ae-btn primary" data-a="resume">Continuar</button>
          <button class="ae-btn" data-a="settings">Configurações</button>
          <button class="ae-btn" data-a="quit">Abandonar partida</button>
        </div>
      </div>`);
    this.settingsEl = this.layer("ae-settings", `
      <div class="ae-card">
        <div class="ae-logo" style="font-size:26px">Configurações</div>
        <div class="ae-row"><span>Sensibilidade</span><input type="range" data-k="sensitivity" min="0.2" max="3" step="0.05"><output></output></div>
        <div class="ae-row"><span>Campo de visão</span><input type="range" data-k="fov" min="70" max="110" step="1"><output></output></div>
        <div class="ae-row"><span>Volume</span><input type="range" data-k="volume" min="0" max="1" step="0.05"><output></output></div>
        <div class="ae-row"><span>Mira</span><select data-k="crosshair"><option value="#7dff9a">Verde</option><option value="#ffffff">Branca</option><option value="#ffd24a">Amarela</option><option value="#ff5a5a">Vermelha</option><option value="#5ac8ff">Azul</option></select></div>
        <div class="ae-row"><span>Opções</span><label class="sw"><input type="checkbox" data-k="shadows"> Sombras</label></div>
        <div class="ae-row"><span></span><label class="sw"><input type="checkbox" data-k="invertY"> Inverter eixo Y do mouse</label></div>
        <div class="ae-btns"><button class="ae-btn primary" data-a="back">Voltar</button></div>
      </div>`);
    this.results = this.layer("ae-results", "");
    this.ver = document.createElement("div");
    this.ver.className = "ae-ver"; this.ver.textContent = `ACTION ELITE · v${__GAME_VERSION__}`;
    document.body.appendChild(this.ver);

    for (const root of [this.menu, this.setup, this.profileEl, this.pause, this.settingsEl, this.results]) {
      root.addEventListener("click", (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
        const a = t?.dataset.a;
        if (!a) return;
        act.click();
        this.onAction(a, t!);
      });
    }
    this.settingsEl.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const k = el.dataset.k as keyof Settings | undefined;
      if (!k) return;
      const s = this.settings as unknown as Record<string, unknown>;
      if (el instanceof HTMLInputElement && el.type === "checkbox") s[k] = el.checked;
      else if (el instanceof HTMLInputElement) s[k] = parseFloat(el.value);
      else s[k] = el.value;
      this.refreshSettings();
      act.settingsChanged(this.settings);
    });
    this.setup.addEventListener("input", (e) => this.onSetupInput(e.target as HTMLInputElement | HTMLSelectElement));
    this.profileEl.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.k === "name") { const n = el.value.replace(/[<>]/g, "").slice(0, 14); this.profile.name = n || "Jogador"; act.nameChanged(this.profile.name); }
    });
    this.renderMenu(); this.renderSetup(); this.renderProfile(); this.refreshSettings();
  }

  private layer(id: string, html: string): HTMLElement {
    const d = document.createElement("div");
    d.id = id; d.className = "ae-layer"; d.innerHTML = html;
    document.body.appendChild(d);
    return d;
  }

  private onAction(a: string, el: HTMLElement): void {
    const act = this.act;
    if (a === "modes") { this.renderSetup(); this.show("setup"); }
    else if (a === "online") { this.show("none"); act.openOnline(); }
    else if (a === "train") act.startTraining();
    else if (a === "profile") { this.renderProfile(); this.show("profile"); }
    else if (a === "start") { saveRoom(this.room); act.startMatch({ ...this.room, playerName: this.profile.name }); }
    else if (a === "tomenu") { this.renderMenu(); this.show("menu"); }
    else if (a === "resume") act.resume();
    else if (a === "quit") act.quitToMenu();
    else if (a === "again") act.playAgain();
    else if (a === "settings") this.settingsEl.classList.add("on");
    else if (a === "back") this.settingsEl.classList.remove("on");
    else if (a === "seg") {
      const k = el.dataset.k as string, v = el.dataset.v as string;
      const r = this.room as unknown as Record<string, unknown>;
      r[k] = k === "mode" ? (v as ModeId) : Number(v);
      this.renderSetup();
    }
  }

  private onSetupInput(el: HTMLInputElement | HTMLSelectElement): void {
    const k = el.dataset.k;
    if (!k) return;
    const r = this.room as unknown as Record<string, unknown>;
    if (el instanceof HTMLInputElement && el.type === "checkbox") r[k] = el.checked;
    else r[k] = Number(el.value);
    if (k === "teamSize") { const o = this.setup.querySelector<HTMLOutputElement>("output[data-o=teamSize]"); if (o) o.textContent = `${this.room.teamSize} x ${this.room.teamSize}`; }
  }

  // ---------------------------------------------------------------- screens
  renderMenu(): void {
    const p = this.profile, li = levelInfo(p.xp);
    this.menu.innerHTML = `
      <div class="ae-card">
        <div>
          <div class="ae-logo">Action<b>Elite</b></div>
          <div class="ae-sub">Parte 3 · Online</div>
          <div class="ae-profilebox"><b>${esc(p.name)}</b> · ${rankName(li.level)} · nível ${li.level}
            <div class="xp"><i style="width:${Math.round((li.into / li.next) * 100)}%"></i></div></div>
          <div class="ae-btns">
            <button class="ae-btn primary" data-a="modes">Modos offline<small>Deathmatch por equipes e Missão Bomba contra bots.</small></button>
            <button class="ae-btn" data-a="train">Treino offline<small>Campo de tiro com alvos. Todas as armas.</small></button>
            <button class="ae-btn" data-a="profile">Perfil<small>Apelido, nível e estatísticas.</small></button>
            <button class="ae-btn" data-a="settings">Configurações</button>
            <button class="ae-btn" data-a="online">Jogar online<small>Salas e partidas contra jogadores reais.</small></button>
          </div>
        </div>
        <div class="ae-keys">
          <h3>Controles</h3>
          <div><kbd>W A S D</kbd>mover</div><div><kbd>Mouse</kbd>mirar</div><div><kbd>Botão esq.</kbd>atirar</div><div><kbd>Botão dir.</kbd>mira da Longbow</div>
          <div><kbd>Shift</kbd>correr</div><div><kbd>Espaço</kbd>pular</div><div><kbd>Ctrl / C</kbd>agachar</div>
          <div><kbd>R</kbd>recarregar</div><div><kbd>1 – 6 / Roda</kbd>trocar de arma</div><div><kbd>Q</kbd>arma anterior</div>
          <div><kbd>E (segurar)</kbd>plantar / desarmar</div><div><kbd>Tab</kbd>placar</div><div><kbd>Esc</kbd>pausar</div>
        </div>
      </div>`;
  }

  renderSetup(): void {
    const r = this.room;
    const seg = (k: string, opts: [string | number, string][], cur: string | number) =>
      `<div class="ae-seg">${opts.map(([v, l]) => `<button data-a="seg" data-k="${k}" data-v="${v}" class="${String(cur) === String(v) ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const sel = (k: string, opts: [number, string][], cur: number) => `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const dm = r.mode === "deathmatch";
    this.setup.innerHTML = `
      <div class="ae-card" style="grid-template-columns:1fr;width:min(94vw,600px);gap:12px">
        <div class="ae-logo" style="font-size:26px">Criar partida offline</div>
        <div class="ae-field"><span>Modo</span>${seg("mode", [["deathmatch", "Deathmatch"], ["bomb", "Missão Bomba"]], r.mode)}</div>
        <div class="ae-field"><span>Mapa</span><select disabled><option>Depósito 01</option></select></div>
        <div class="ae-field"><span>Jogadores</span><input type="range" data-k="teamSize" min="1" max="8" step="1" value="${r.teamSize}"><output data-o="teamSize">${r.teamSize} x ${r.teamSize}</output></div>
        <div class="ae-field"><span>Dificuldade dos bots</span>${seg("difficulty", [[0, "Fácil"], [1, "Normal"], [2, "Difícil"], [3, "Elite"]], r.difficulty)}</div>
        <div class="ae-field"><span>Sua arma</span>${seg("primary", [[4, "Raptor AR"], [3, "Spitfire"], [5, "Hammer 12"], [6, "Longbow X"]], r.primary)}</div>
        ${dm
          ? `<div class="ae-field"><span>Limite de abates</span>${sel("killLimit", [[20, "20"], [30, "30"], [50, "50"], [75, "75"]], r.killLimit)}</div>
             <div class="ae-field"><span>Tempo</span>${sel("timeLimit", [[300, "5 minutos"], [480, "8 minutos"], [600, "10 minutos"]], r.timeLimit)}</div>`
          : `<div class="ae-field"><span>Rodadas</span>${sel("roundsToWin", [[2, "Melhor de 3"], [3, "Melhor de 5"], [5, "Melhor de 9"]], r.roundsToWin)}</div>
             <div class="ae-field"><span>Tempo da rodada</span>${sel("roundTime", [[90, "1:30"], [120, "2:00"], [150, "2:30"]], r.roundTime)}</div>
             <div class="ae-field"><span></span><label class="sw"><input type="checkbox" data-k="swapSides" ${r.swapSides ? "checked" : ""}> Trocar de lado no meio da partida</label></div>`}
        <div class="ae-field"><span></span><label class="sw"><input type="checkbox" data-k="friendlyFire" ${r.friendlyFire ? "checked" : ""}> Fogo amigo</label></div>
        <div class="ae-two"><button class="ae-btn" data-a="tomenu">Voltar</button><button class="ae-btn primary" data-a="start">Iniciar partida</button></div>
      </div>`;
  }

  renderProfile(): void {
    const p = this.profile, li = levelInfo(p.xp);
    const kd = p.deaths ? (p.kills / p.deaths).toFixed(2) : String(p.kills);
    const acc = p.shots ? Math.round((p.hits / p.shots) * 100) : 0;
    const hrs = p.seconds >= 3600 ? `${(p.seconds / 3600).toFixed(1)} h` : `${Math.round(p.seconds / 60)} min`;
    this.profileEl.innerHTML = `
      <div class="ae-card" style="grid-template-columns:1fr;width:min(94vw,560px);gap:12px">
        <div class="ae-logo" style="font-size:26px">Perfil</div>
        <div class="ae-field"><span>Apelido</span><input type="text" data-k="name" maxlength="14" value="${esc(p.name)}"></div>
        <div class="ae-profilebox"><b>${rankName(li.level)}</b> · nível ${li.level} · ${li.into} / ${li.next} XP<div class="xp"><i style="width:${Math.round((li.into / li.next) * 100)}%"></i></div></div>
        <div class="ae-statgrid">
          <div>Partidas <b>${p.matches}</b></div><div>Vitórias <b>${p.wins}</b></div>
          <div>Abates <b>${p.kills}</b></div><div>Mortes <b>${p.deaths}</b></div>
          <div>Abates / mortes <b>${kd}</b></div><div>Tiros na cabeça <b>${p.headshots}</b></div>
          <div>Precisão <b>${acc}%</b></div><div>Tempo jogado <b>${hrs}</b></div>
        </div>
        <div class="ae-btns"><button class="ae-btn primary" data-a="tomenu">Voltar</button></div>
      </div>`;
  }

  /** the results screen at the end of a match */
  showResults(title: "win" | "lose" | "draw", headline: string, table: string, xp: number, level: { before: number; after: number }, sub: string, online = false): void {
    const li = levelInfo(this.profile.xp);
    this.results.innerHTML = `
      <div class="ae-card">
        <div class="ae-res-title ${title}">${esc(headline)}</div>
        <div class="ae-sub" style="margin:0">${esc(sub)}</div>
        <div class="ae-sb inline">${table}</div>
        <div class="ae-profilebox">+${xp} XP · ${rankName(li.level)} · nível ${li.level}${level.after > level.before ? ` <b style="color:#7dff9a">· subiu de nível!</b>` : ""}<div class="xp"><i style="width:${Math.round((li.into / li.next) * 100)}%"></i></div></div>
        <div class="ae-two"><button class="ae-btn" data-a="quit">Menu principal</button><button class="ae-btn primary" data-a="again">${online ? "Voltar à sala" : "Jogar de novo"}</button></div>
      </div>`;
    this.show("results");
  }

  refreshSettings(): void {
    const s = this.settings as unknown as Record<string, unknown>;
    this.settingsEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-k]").forEach((el) => {
      const v = s[el.dataset.k as string];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
      else el.value = String(v);
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = el.dataset.k === "volume" ? `${Math.round(Number(v) * 100)}%` : String(v);
    });
  }

  show(which: Which): void {
    this.menu.classList.toggle("on", which === "menu");
    this.setup.classList.toggle("on", which === "setup");
    this.profileEl.classList.toggle("on", which === "profile");
    this.pause.classList.toggle("on", which === "pause");
    this.results.classList.toggle("on", which === "results");
    if (which === "none") this.settingsEl.classList.remove("on");
  }
}
