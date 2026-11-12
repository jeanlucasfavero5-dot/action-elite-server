// The hub's Supabase (PostgREST over fetch, no SDK): the official nick (`usuarios`) and the diamond wallet
// (`carteira_diamantes`), both keyed by `id_jogador`. Reads work with the publishable key; charging the wallet needs
// SUPABASE_SERVICE_ROLE_KEY, which only the server holds.
import { config } from "../config.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [hub] ${m}`);

// the rate (500 gold = 5 diamonds) is one definition, shared with the client shop
export { GOLD_PER_DIAMOND, diamondPrice } from "../../../src/diamonds.ts";

/** hub player id: what the portal puts in ?id=. Also the only shape that ever reaches a PostgREST filter. */
export const isHubId = (id: string): boolean => /^[A-Za-z0-9]{1,15}$/.test(id);

export class HubError extends Error {
  readonly kind: "unavailable" | "not_configured";
  constructor(kind: "unavailable" | "not_configured", message: string) {
    super(message);
    this.kind = kind;
  }
}

function authHeaders(key: string): Record<string, string> {
  // a legacy service_role / anon key is a JWT (also sent as Bearer); a new sb_secret_ / sb_publishable_ key goes in apikey only
  return key.startsWith("eyJ") ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

async function rest(method: "GET" | "PATCH", pathAndQuery: string, body?: unknown, write = false): Promise<Record<string, unknown>[]> {
  const key = write ? config.supabaseServiceKey : config.supabaseServiceKey || config.supabaseAnonKey;
  if (!key) throw new HubError("not_configured", "SUPABASE_SERVICE_ROLE_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`${config.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      method,
      headers: { ...authHeaders(key), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json", prefer: "return=representation" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    throw new HubError("unavailable", `supabase unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new HubError("unavailable", `supabase answered ${res.status}`);
  const data: unknown = await res.json().catch(() => []);
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

const NICK_COLS = ["nick", "nickname", "nome", "username"];

export interface HubUser { id: string; nick: string }

/** `usuarios` row of the player, null when the hub has no such player. `nick` is "" when no known nick column is in the row. */
export async function fetchHubUser(id: string): Promise<HubUser | null> {
  if (!isHubId(id)) return null;
  const rows = await rest("GET", `usuarios?id_jogador=eq.${id}&select=*&limit=1`);
  const row = rows[0];
  if (!row) return null;
  const nick = NICK_COLS.map((c) => row[c]).find((v) => typeof v === "string" && v.trim() !== "");
  return { id, nick: typeof nick === "string" ? nick.trim() : "" };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** diamonds of the player (a player with no wallet row holds 0) */
export async function readDiamonds(id: string): Promise<number> {
  if (!isHubId(id)) return 0;
  const rows = await rest("GET", `carteira_diamantes?id_jogador=eq.${id}&select=diamantes&limit=1`);
  return num(rows[0]?.diamantes) ?? 0;
}

/** One conditional UPDATE: it only matches while the balance is still the one just read, so two purchases at once can not both
 * spend it (the loser re-reads). null = the wallet row is gone or never existed. */
async function swapBalance(id: string, from: number, to: number): Promise<boolean> {
  const rows = await rest("PATCH", `carteira_diamantes?id_jogador=eq.${id}&diamantes=eq.${from}&select=diamantes`, { diamantes: to }, true);
  return rows.length > 0;
}

export type DebitResult = "ok" | "insufficient";

export async function debitDiamonds(id: string, amount: number): Promise<DebitResult> {
  if (!isHubId(id) || !Number.isInteger(amount) || amount <= 0) throw new HubError("unavailable", "bad debit request");
  for (let attempt = 0; attempt < 6; attempt++) {
    const balance = await readDiamonds(id);
    if (balance < amount) return "insufficient";
    if (await swapBalance(id, balance, balance - amount)) return "ok";
  }
  throw new HubError("unavailable", "wallet busy");
}

/** gives diamonds back (a purchase that failed after the debit). false = could not, the caller logs it. */
export async function creditDiamonds(id: string, amount: number): Promise<boolean> {
  if (!isHubId(id) || !Number.isInteger(amount) || amount <= 0) return false;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const balance = await readDiamonds(id);
      if (await swapBalance(id, balance, balance + amount)) return true;
    }
  } catch (e) {
    log(`credit ${amount} to ${id} failed: ${(e as Error).message}`);
  }
  return false;
}
