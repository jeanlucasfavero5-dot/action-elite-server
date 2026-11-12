// Diamonds: the hub's currency (Supabase carteira_diamantes). The shop sells every gold-priced good for diamonds at a
// fixed rate, 500 gold = 5 diamonds. The rate is defined here once: the client shop shows it and the server
// (server/src/hub/supabase.ts) charges it. The balance below is only what the hub reports to the client (src/hub.ts).

/** gold paid by one diamond: 500 gold = 5 diamonds */
export const GOLD_PER_DIAMOND = 100;

/** diamond price of a good with this gold price; 0 = not sold for diamonds (no gold price). Rounded up: never below the rate. */
export const diamondPrice = (gold: number): number => (gold > 0 ? Math.max(1, Math.ceil(gold / GOLD_PER_DIAMOND)) : 0);

let balance: number | null = null;
let refresher: (() => void) | null = null;
const listeners = new Set<() => void>();

/** the hub's last reported balance (null = unknown: opened outside the hub, or not loaded yet) */
export const getDiamonds = (): number | null => balance;

export function setDiamonds(n: number | null): void {
  if (n === balance) return;
  balance = n;
  for (const fn of listeners) fn();
}

export function onDiamonds(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** hub.ts registers how to re-read the wallet; the shop asks for it right after a diamond purchase */
export const setDiamondsRefresher = (fn: () => void): void => { refresher = fn; };
export const refreshDiamonds = (): void => refresher?.();
