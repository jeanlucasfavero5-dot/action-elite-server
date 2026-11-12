// Accounts of the hub: one game account per hub player (`usuarios.id_jogador`), made on the first entry. There is no password:
// the portal passes the player id (?id=) and POST /api/hub-login checks it against the hub's database. account_hub_links
// ties the hub id to accounts.player_id; the diamond purchases read it to know whose wallet to charge.
import { pool } from "../db.ts";
import { generateToken, storedToken } from "../web/accounts/token.ts";
import { isReservedNick } from "../web/accounts/validation.ts";
import { AccountApiError, type LoginResult } from "../web/accounts/accounts.ts";
import { fetchHubUser, isHubId, HubError } from "./supabase.ts";

export async function ensureHubSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_hub_links (
      hub_id varchar(15) PRIMARY KEY,
      player_id bigint NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** the account's nickname (varchar(16)): the hub nick, or a name made from the id when it is empty or one a player must not take */
export function hubNickname(nick: string, hubId: string): string {
  const clean = [...nick.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, 16).join("");
  return clean && !isReservedNick(clean) ? clean : `Jogador${hubId.slice(-8)}`;
}

/** hub id of a game account, "" when the account was not made through the hub */
export async function hubIdOfPlayer(playerId: bigint): Promise<string> {
  const r = await pool.query("SELECT hub_id FROM account_hub_links WHERE player_id = $1", [String(playerId)]);
  return r.rows[0]?.hub_id ?? "";
}

export async function hubLogin(hubId: string): Promise<LoginResult> {
  if (!isHubId(hubId)) throw new AccountApiError(400, "ID do jogador inválido.");
  let user;
  try {
    user = await fetchHubUser(hubId);
  } catch (e) {
    console.error(`[hub] login ${hubId}: ${(e as Error).message}`);
    throw new AccountApiError(503, "Hub indisponível. Tente de novo em instantes.");
  }
  if (!user) throw new AccountApiError(404, "Jogador não encontrado no Hub.");
  const nickname = hubNickname(user.nick, hubId);
  // two first entries of one player at once: the second INSERT of the link fails, and its retry takes the existing account
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await loginOrCreate(hubId, nickname);
    } catch (e) {
      if ((e as { code?: string }).code !== "23505" || attempt === 1) throw e;
    }
  }
  throw new AccountApiError(500, "internal error");
}

async function loginOrCreate(hubId: string, nickname: string): Promise<LoginResult> {
  const token = generateToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const link = await client.query("SELECT player_id FROM account_hub_links WHERE hub_id = $1", [hubId]);
    let row;
    if (link.rowCount) {
      const upd = await client.query(
        "UPDATE accounts SET token = $1, nickname = $2 WHERE player_id = $3 RETURNING player_id, nickname",
        [storedToken(token), nickname, link.rows[0].player_id],
      );
      if (!upd.rowCount) throw new AccountApiError(401, "Conta do jogo não encontrada.");
      row = upd.rows[0];
    } else {
      const username = `h${hubId}`; // 2-16 chars: the same shape the game's accounts use
      if ((await client.query("SELECT 1 FROM accounts WHERE username = $1", [username])).rowCount) throw new AccountApiError(409, "Conta já existe fora do Hub.");
      const ins = await client.query(
        `INSERT INTO accounts (username, password, nickname, email, token, gold, cash, access_level)
         VALUES ($1, $2, $3, $4, $5, 100000, 80000, 0) RETURNING player_id, nickname`,
        [username, generateToken().slice(0, 12), nickname, `${username}@hub.local`, storedToken(token)],
      );
      row = ins.rows[0];
      await client.query("INSERT INTO account_hub_links (hub_id, player_id) VALUES ($1, $2)", [hubId, row.player_id]);
    }
    await client.query("COMMIT");
    return { token, playerId: String(row.player_id), nickname: row.nickname };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export { HubError };
