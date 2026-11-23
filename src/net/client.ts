// The WebSocket to the server: JSON messages in both directions, a status, and a ping estimate.
export type NetStatus = "idle" | "connecting" | "open" | "closed";

export class NetClient {
  private ws: WebSocket | null = null;
  status: NetStatus = "idle";
  id = 0;
  name = "";
  /** round-trip time in ms (smoothed) */
  ping = 0;
  url = "";
  onMessage: (msg: Record<string, unknown>) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** opens the connection and says hello; resolves with the player id the server gave */
  connect(url: string, name: string): Promise<number> {
    this.close();
    this.url = url; this.name = name;
    this.setStatus("connecting");
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { this.setStatus("closed"); reject(e); return; }
      this.ws = ws;
      const timeout = setTimeout(() => { if (this.status === "connecting") { ws.close(); reject(new Error("tempo esgotado")); } }, 8000);
      ws.onopen = () => this.send({ t: "hello", name });
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.t === "welcome") {
          clearTimeout(timeout);
          this.id = msg.id as number; this.name = msg.name as string;
          this.setStatus("open");
          this.pingTimer = setInterval(() => this.send({ t: "ping", c: Date.now() }), 2000);
          this.send({ t: "ping", c: Date.now() });
          resolve(this.id);
          return;
        }
        if (msg.t === "pong") { const rtt = Date.now() - (msg.c as number); this.ping = this.ping ? this.ping * 0.7 + rtt * 0.3 : rtt; return; }
        this.onMessage(msg);
      };
      ws.onerror = () => { clearTimeout(timeout); if (this.status === "connecting") reject(new Error("não foi possível conectar")); };
      ws.onclose = () => { clearTimeout(timeout); if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; if (this.ws === ws) { this.ws = null; this.setStatus("closed"); } };
    });
  }

  send(msg: unknown): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.close(); }
    if (this.status !== "idle") this.setStatus("closed");
  }

  private setStatus(s: NetStatus): void { this.status = s; this.onStatus(s); }
}
