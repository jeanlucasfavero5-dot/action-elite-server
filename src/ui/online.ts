// The online screens: connect, the list of rooms, creating a room, and the room lobby (teams, gun, chat, start).
import { NetClient, type NetStatus } from "../net/client.ts";
import { serverUrl } from "../net/url.ts";
import { DEFAULT_ROOM, MAX_ROOM, type RoomConfig, type RoomListItem, type RoomState } from "../net/protocol.ts";

const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const CFG_KEY = "action-elite.online.v1";
const GUNS: [number, string][] = [[4, "Raptor AR"], [3, "Spitfire S35"], [5, "Hammer 12"], [6, "Longbow X"]];

export interface OnlineHooks {
  playerName(): string;
  /** the server started the match: build it and take over the messages */
  onStart(net: NetClient, start: Record<string, unknown>): void;
  /** back to the title screen */
  onBack(): void;
  click(): void;
}

function loadCfg(): RoomConfig {
  try { const raw = localStorage.getItem(CFG_KEY); if (raw) return { ...DEFAULT_ROOM, ...(JSON.parse(raw) as Partial<RoomConfig>) }; } catch { /* blocked */ }
  return { ...DEFAULT_ROOM };
}

export class OnlineUi {
  readonly net = new NetClient();
  readonly listEl: HTMLElement;
  readonly roomEl: HTMLElement;
  private hooks: OnlineHooks;
  private rooms: RoomListItem[] = [];
  private room: RoomState | null = null;
  private chat: { from: string; text: string }[] = [];
  private cfg: RoomConfig = loadCfg();
  private creating = false;
  private error = "";
  private poll: ReturnType<typeof setInterval> | null = null;
  private quick = false;
  private connecting = false;
  /** a match is running: the lobby must not pop up over it */
  private inMatch = false;

  constructor(hooks: OnlineHooks) {
    this.hooks = hooks;
    this.listEl = this.layer("ae-online");
    this.roomEl = this.layer("ae-room");
    for (const root of [this.listEl, this.roomEl]) {
      root.addEventListener("click", (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>("[data-a]"); if (t) { hooks.click(); this.action(t.dataset.a!, t); } });
      root.addEventListener("input", (e) => this.input(e.target as HTMLInputElement | HTMLSelectElement));
      root.addEventListener("keydown", (e) => { const el = e.target as HTMLInputElement; if (e.key === "Enter" && el.dataset.k === "chat") { this.say(el); } e.stopPropagation(); });
    }
    this.net.onMessage = (m) => this.onMsg(m);
    this.net.onStatus = () => { if (this.listEl.classList.contains("on")) this.renderList(); };
  }

  private layer(id: string): HTMLElement {
    const d = document.createElement("div");
    d.id = id; d.className = "ae-layer"; d.style.cssText = "align-items:center;justify-content:center;background:rgba(0,0,0,.78);z-index:23";
    document.body.appendChild(d);
    return d;
  }

  // ---------------------------------------------------------------- open / close
  async open(): Promise<void> {
    this.room = null; this.error = ""; this.creating = false; this.inMatch = false;
    this.listEl.classList.add("on"); this.roomEl.classList.remove("on");
    this.renderList();
    if (this.net.status !== "open") await this.connect();
    else this.refresh();
    this.startPolling();
  }

  hide(): void {
    this.listEl.classList.remove("on"); this.roomEl.classList.remove("on");
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true; this.error = "";
    this.renderList();
    try { await this.net.connect(serverUrl(), this.hooks.playerName()); this.refresh(); }
    catch (e) { this.error = `Não foi possível conectar a ${serverUrl()}. ${(e as Error).message}.`; }
    this.connecting = false;
    this.renderList();
  }

  private startPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(() => { if (this.listEl.classList.contains("on") && this.net.status === "open") this.refresh(); }, 4000);
  }

  private refresh(): void { this.net.send({ t: "rooms" }); }

  /** back from a match: the room lobby again (the server sent the room) */
  showRoom(): void {
    this.inMatch = false;
    if (!this.room || this.net.status !== "open") { void this.open(); return; }
    this.listEl.classList.remove("on"); this.roomEl.classList.add("on"); this.renderRoom();
  }

  // ---------------------------------------------------------------- messages
  onMsg(m: Record<string, unknown>): void {
    switch (m.t) {
      case "rooms": this.rooms = m.list as RoomListItem[]; if (this.listEl.classList.contains("on")) this.renderList(); break;
      case "room": {
        this.room = m.room as RoomState;
        if (!this.inMatch) this.showRoomIfIn();
        if (this.quick && this.room.players.length === 1 && this.room.players[0].host) { this.quick = false; this.net.send({ t: "start" }); }
        break;
      }
      case "chat": this.chat.push({ from: String(m.from ?? ""), text: String(m.text ?? "") }); if (this.chat.length > 60) this.chat.shift(); if (this.roomEl.classList.contains("on")) this.renderRoom(true); break;
      case "err": this.error = String(m.msg ?? "Erro."); this.renderCurrent(); break;
      case "left": this.room = null; this.chat = []; this.inMatch = false; if (this.roomEl.classList.contains("on")) { this.roomEl.classList.remove("on"); this.listEl.classList.add("on"); this.renderList(); this.refresh(); } break;
      case "start": this.inMatch = true; this.hide(); this.hooks.onStart(this.net, m); break;
      case "back": this.error = ""; break;
    }
  }

  private showRoomIfIn(): void {
    if (!this.room) return;
    this.listEl.classList.remove("on"); this.roomEl.classList.add("on");
    this.renderRoom();
  }
  private renderCurrent(): void { if (this.roomEl.classList.contains("on")) this.renderRoom(); else this.renderList(); }

  // ---------------------------------------------------------------- actions
  private action(a: string, el: HTMLElement): void {
    const net = this.net;
    switch (a) {
      case "back": this.hide(); this.hooks.onBack(); break;
      case "retry": void this.connect(); break;
      case "refresh": this.refresh(); break;
      case "newroom": this.creating = !this.creating; this.error = ""; this.renderList(); break;
      case "create": try { localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg)); } catch { /* ignore */ } this.creating = false; net.send({ t: "create", cfg: this.cfg }); break;
      case "join": net.send({ t: "join", id: Number(el.dataset.id) }); break;
      case "quick": {
        const open = this.rooms.find((r) => r.state === "lobby" && r.players < r.max);
        if (open) net.send({ t: "join", id: open.id });
        else { this.quick = true; net.send({ t: "create", cfg: { ...DEFAULT_ROOM, name: `Partida de ${this.hooks.playerName()}`, fillBots: true } }); }
        break;
      }
      case "seg": { const k = el.dataset.k as keyof RoomConfig, v = el.dataset.v!; (this.cfg as unknown as Record<string, unknown>)[k] = k === "mode" ? v : Number(v); this.renderList(); break; }
      case "leave": net.send({ t: "leave" }); break;
      case "team": net.send({ t: "team", team: Number(el.dataset.team) }); break;
      case "ready": { const me = this.me(); net.send({ t: "ready", on: !me?.ready }); break; }
      case "gun": net.send({ t: "primary", slot: Number(el.dataset.slot) }); break;
      case "start": net.send({ t: "start" }); break;
      case "send": { const inp = this.roomEl.querySelector<HTMLInputElement>("[data-k=chat]"); if (inp) this.say(inp); break; }
    }
  }

  private say(el: HTMLInputElement): void { const t = el.value.trim(); if (t) this.net.send({ t: "say", text: t }); el.value = ""; }

  private input(el: HTMLInputElement | HTMLSelectElement): void {
    const k = el.dataset.k as string | undefined;
    if (!k || k === "chat") return;
    const c = this.cfg as unknown as Record<string, unknown>;
    if (k === "name") c[k] = el.value;
    else if (el instanceof HTMLInputElement && el.type === "checkbox") c[k] = el.checked;
    else c[k] = Number(el.value);
    if (k === "teamSize") { const o = this.listEl.querySelector<HTMLOutputElement>("output[data-o=teamSize]"); if (o) o.textContent = `${this.cfg.teamSize} x ${this.cfg.teamSize}`; }
  }

  private me() { return this.room?.players.find((p) => p.id === this.net.id); }

  // ---------------------------------------------------------------- screens
  private statusText(s: NetStatus): string {
    if (s === "open") return `<span style="color:#7dff9a">● Conectado</span> · ${Math.round(this.net.ping)} ms`;
    if (s === "connecting" || this.connecting) return `<span style="color:#ffd24a">● Conectando…</span>`;
    return `<span style="color:#ff6a5e">● Desconectado</span>`;
  }

  renderList(): void {
    const c = this.cfg, open = this.net.status === "open";
    const seg = (k: string, opts: [string | number, string][], cur: string | number) => `<div class="ae-seg">${opts.map(([v, l]) => `<button data-a="seg" data-k="${k}" data-v="${v}" class="${String(cur) === String(v) ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const sel = (k: string, opts: [number, string][], cur: number) => `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const rows = this.rooms.length
      ? this.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.mode === "bomb" ? "Missão Bomba" : "Deathmatch"}</td><td>${r.players} / ${r.max}${r.bots ? " + bots" : ""}</td><td>${r.state === "lobby" ? "Aguardando" : "Em jogo"}</td><td style="text-align:right">${r.state === "lobby" && r.players < r.max ? `<button class="ae-btn" style="padding:6px 14px" data-a="join" data-id="${r.id}">Entrar</button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="5" style="opacity:.6;padding:14px 0">Nenhuma sala. Crie uma ou use a partida rápida.</td></tr>`;
    const form = this.creating ? `
      <div class="ae-form">
        <div class="ae-field"><span>Nome da sala</span><input type="text" data-k="name" maxlength="24" value="${esc(c.name)}"></div>
        <div class="ae-field"><span>Modo</span>${seg("mode", [["deathmatch", "Deathmatch"], ["bomb", "Missão Bomba"]], c.mode)}</div>
        <div class="ae-field"><span>Jogadores</span><input type="range" data-k="teamSize" min="1" max="${MAX_ROOM / 2}" step="1" value="${c.teamSize}"><output data-o="teamSize">${c.teamSize} x ${c.teamSize}</output></div>
        <div class="ae-field"><span>Vagas vazias</span><label class="sw"><input type="checkbox" data-k="fillBots" ${c.fillBots ? "checked" : ""}> Preencher com bots</label></div>
        <div class="ae-field"><span>Dificuldade dos bots</span>${seg("difficulty", [[0, "Fácil"], [1, "Normal"], [2, "Difícil"], [3, "Elite"]], c.difficulty)}</div>
        ${c.mode === "deathmatch"
          ? `<div class="ae-field"><span>Limite de abates</span>${sel("killLimit", [[20, "20"], [30, "30"], [50, "50"], [75, "75"]], c.killLimit)}</div>`
          : `<div class="ae-field"><span>Rodadas</span>${sel("roundsToWin", [[2, "Melhor de 3"], [3, "Melhor de 5"], [5, "Melhor de 9"]], c.roundsToWin)}</div>`}
        <div class="ae-two"><button class="ae-btn" data-a="newroom">Cancelar</button><button class="ae-btn primary" data-a="create">Criar sala</button></div>
      </div>` : "";
    this.listEl.innerHTML = `
      <div class="ae-card" style="grid-template-columns:1fr;width:min(96vw,720px);gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><div class="ae-logo" style="font-size:28px">Jogar online</div><div style="font-size:12px">${this.statusText(this.net.status)}</div></div>
        <div class="ae-sub" style="margin:0;text-transform:none;letter-spacing:0">${esc(serverUrl())}</div>
        ${this.error ? `<div class="ae-err">${esc(this.error)}</div>` : ""}
        ${open ? `
          <div class="ae-two" style="grid-template-columns:1fr 1fr 1fr"><button class="ae-btn primary" data-a="quick">Partida rápida</button><button class="ae-btn" data-a="newroom">Criar sala</button><button class="ae-btn" data-a="refresh">Atualizar</button></div>
          ${form}
          <table class="ae-rooms"><thead><tr><th>Sala</th><th>Modo</th><th>Jogadores</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="ae-btns"><button class="ae-btn primary" data-a="retry" ${this.connecting ? "disabled" : ""}>Tentar conectar de novo</button></div>`}
        <div class="ae-btns"><button class="ae-btn" data-a="back">Voltar ao menu</button></div>
      </div>`;
  }

  renderRoom(chatOnly = false): void {
    const r = this.room;
    if (!r) return;
    const me = this.me(), host = !!me?.host;
    const chatHtml = this.chat.map((m) => `<div>${m.from ? `<b>${esc(m.from)}</b> ` : "<i>"}${esc(m.text)}${m.from ? "" : "</i>"}</div>`).join("");
    if (chatOnly) {
      const box = this.roomEl.querySelector<HTMLElement>(".ae-chatbox");
      if (box) { box.innerHTML = chatHtml; box.scrollTop = box.scrollHeight; return; }
    }
    const col = (team: number) => {
      const ps = r.players.filter((p) => p.team === team);
      const slots = Array.from({ length: r.cfg.teamSize }, (_, i) => ps[i]);
      return `<div class="ae-team t${team}"><h4>${team === 0 ? "Azul" : "Vermelho"}</h4>${slots.map((p) => p ? `<div class="pl${p.id === this.net.id ? " me" : ""}">${p.host ? "★ " : ""}${esc(p.name)}<span>${p.ready ? "pronto" : ""}</span></div>` : `<div class="pl empty">${r.cfg.fillBots ? "bot" : "vaga livre"}</div>`).join("")}${me && me.team !== team ? `<button class="ae-btn" style="padding:6px" data-a="team" data-team="${team}">Entrar nesta equipe</button>` : ""}</div>`;
    };
    const summary = r.cfg.mode === "bomb" ? `Missão Bomba · melhor de ${r.cfg.roundsToWin * 2 - 1}` : `Deathmatch · ${r.cfg.killLimit} abates`;
    this.roomEl.innerHTML = `
      <div class="ae-card" style="grid-template-columns:1fr;width:min(96vw,760px);gap:10px">
        <div class="ae-logo" style="font-size:26px">${esc(r.cfg.name)}</div>
        <div class="ae-sub" style="margin:0">${summary} · ${r.cfg.teamSize} x ${r.cfg.teamSize}${r.cfg.fillBots ? " · bots preenchem as vagas" : ""}</div>
        ${this.error ? `<div class="ae-err">${esc(this.error)}</div>` : ""}
        <div class="ae-teams">${col(0)}${col(1)}</div>
        <div class="ae-field" style="grid-template-columns:90px 1fr"><span>Sua arma</span><div class="ae-seg">${GUNS.map(([s, n]) => `<button data-a="gun" data-slot="${s}" class="${me?.primary === s ? "on" : ""}">${n}</button>`).join("")}</div></div>
        <div class="ae-chat"><div class="ae-chatbox">${chatHtml}</div><div class="ae-chatin"><input type="text" data-k="chat" maxlength="120" placeholder="Mensagem…"><button class="ae-btn" style="padding:6px 14px" data-a="send">Enviar</button></div></div>
        <div class="ae-two"><button class="ae-btn" data-a="leave">Sair da sala</button>${host ? `<button class="ae-btn primary" data-a="start">Iniciar partida</button>` : `<button class="ae-btn ${me?.ready ? "primary" : ""}" data-a="ready">${me?.ready ? "Pronto ✓" : "Estou pronto"}</button>`}</div>
      </div>`;
    const box = this.roomEl.querySelector<HTMLElement>(".ae-chatbox");
    if (box) box.scrollTop = box.scrollHeight;
  }
}
