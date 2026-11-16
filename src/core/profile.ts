// The player's profile: nickname, level, experience and totals. Kept in localStorage (when the page allows it).
export interface Profile {
  name: string;
  xp: number;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  headshots: number;
  shots: number;
  hits: number;
  seconds: number;
}

const KEY = "action-elite.profile.v1";
const NEW: Profile = { name: "Jogador", xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, seconds: 0 };

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...NEW, ...(JSON.parse(raw) as Partial<Profile>) };
  } catch { /* blocked */ }
  return { ...NEW };
}

export function saveProfile(p: Profile): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** experience needed to go from level L to L+1 */
export const xpStep = (level: number): number => 200 + 100 * level;

export function levelInfo(xp: number): { level: number; into: number; next: number } {
  let level = 1, left = xp;
  while (left >= xpStep(level)) { left -= xpStep(level); level++; }
  return { level, into: left, next: xpStep(level) };
}

const RANKS = ["Recruta", "Soldado", "Cabo", "Sargento", "Subtenente", "Tenente", "Capitão", "Major", "Coronel", "Elite"];
export const rankName = (level: number): string => RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 3))];

export interface MatchSummary {
  mode: string;
  won: boolean | null; // null = draw
  kills: number; deaths: number; headshots: number; shots: number; hits: number; seconds: number;
  objective: number;
  difficulty: number;
}

const DIFF_MULT = [0.6, 1, 1.3, 1.6];

/** adds a finished match to the profile; returns the experience earned and the level change */
export function awardMatch(p: Profile, s: MatchSummary): { xp: number; levelBefore: number; levelAfter: number } {
  const before = levelInfo(p.xp).level;
  const base = s.kills * 10 + s.headshots * 5 + s.objective * 25 + (s.won === null ? 50 : s.won ? 100 : 30);
  const xp = Math.round(base * (DIFF_MULT[s.difficulty] ?? 1));
  p.xp += xp; p.matches++; if (s.won) p.wins++;
  p.kills += s.kills; p.deaths += s.deaths; p.headshots += s.headshots; p.shots += s.shots; p.hits += s.hits; p.seconds += Math.round(s.seconds);
  saveProfile(p);
  return { xp, levelBefore: before, levelAfter: levelInfo(p.xp).level };
}
