// Action Elite Server: the entry (index) of the server, beside the game's index.html. One process:
//   node index.ts               -> Auth on PB_TS_AUTH_PORT (39290), Game servers on PB_TS_GAME_PORT_BASE+id (39291..),
//                                  web front (ws /tcp /signal, http /api) on PB_WEB_PORT (8090)
import { startAuthServer, accept as acceptAuth } from "./src/auth/authServer.ts";
import { startGameServers, acceptGame } from "./src/game/gameServer.ts";
import { startWebServer, ensureAccountSchema, type Acceptors } from "./src/web/webServer.ts";
import { pool } from "./src/db.ts";
import { loadStaticData } from "./src/shared/data.ts";
import { loadShop } from "./src/shared/shop.ts";
import { startBugRetention } from "./src/game/bugReports.ts";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { name: string; version: string };
console.log(`Action Elite Server v${pkg.version} (${pkg.name})`);

await loadStaticData();
await loadShop();
const servers = [await startAuthServer(), ...(await startGameServers())];
const acceptors: Acceptors = { auth: acceptAuth };
for (let id = 1; id < servers.length; id++) acceptors[`game${id}`] = (sock) => acceptGame(id, sock);
await ensureAccountSchema();
servers.push(await startWebServer(acceptors));
startBugRetention();
// a stray exception / rejection in a timer or a DB call must not take every session down with the process
process.on("uncaughtException", (e) => console.error("[server] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[server] unhandledRejection:", e));
const stop = () => { for (const s of servers) s.close(); void pool.end().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
