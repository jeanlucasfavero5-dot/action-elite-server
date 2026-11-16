// Navigation for bots: a 1 m grid over the ground floor of the yard, A* with 8 directions, and path smoothing.
// Bots walk on the ground only (they do not use the catwalk or climb crates); every solid that stops a walking body blocks a cell.
import type { MapDef, Vec3 } from "./types.ts";
import { rayWorld } from "./hit.ts";

export interface P2 { x: number; z: number }

export class Nav {
  readonly cell = 1;
  readonly n: number;
  private readonly origin: number;
  private readonly walk: Uint8Array;

  private map: MapDef;

  constructor(map: MapDef) {
    this.map = map;
    this.n = Math.ceil((map.half * 2) / this.cell);
    this.origin = -map.half;
    this.walk = new Uint8Array(this.n * this.n);
    const m = 0.55; // body radius plus a margin
    for (let iz = 0; iz < this.n; iz++) for (let ix = 0; ix < this.n; ix++) {
      const c = this.center(ix, iz);
      let free = true;
      for (const b of map.solids) {
        if (b.y1 <= 0.45 || b.y0 >= 1.8) continue; // a floor, or a deck above head height
        if (c.x + m > b.x0 && c.x - m < b.x1 && c.z + m > b.z0 && c.z - m < b.z1) { free = false; break; }
      }
      this.walk[iz * this.n + ix] = free ? 1 : 0;
    }
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.max(0, Math.min(this.n - 1, Math.floor((x - this.origin) / this.cell))), Math.max(0, Math.min(this.n - 1, Math.floor((z - this.origin) / this.cell)))];
  }
  center(ix: number, iz: number): P2 { return { x: this.origin + (ix + 0.5) * this.cell, z: this.origin + (iz + 0.5) * this.cell }; }
  isWalkable(ix: number, iz: number): boolean { return ix >= 0 && iz >= 0 && ix < this.n && iz < this.n && this.walk[iz * this.n + ix] === 1; }

  /** the nearest walkable cell to a point (the point itself when it is free) */
  snap(x: number, z: number): [number, number] {
    const [cx, cz] = this.cellOf(x, z);
    if (this.isWalkable(cx, cz)) return [cx, cz];
    for (let r = 1; r < this.n; r++) {
      let best: [number, number] | null = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!this.isWalkable(cx + dx, cz + dz)) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = [cx + dx, cz + dz]; }
      }
      if (best) return best;
    }
    return [cx, cz];
  }

  /** a random walkable point */
  randomPoint(rng: () => number): P2 {
    for (let i = 0; i < 200; i++) {
      const ix = Math.floor(rng() * this.n), iz = Math.floor(rng() * this.n);
      if (this.isWalkable(ix, iz)) return this.center(ix, iz);
    }
    return { x: 0, z: 0 };
  }

  /** a path from a to b as world points (the first is the start), or null when there is none */
  path(ax: number, az: number, bx: number, bz: number): P2[] | null {
    const [sx, sz] = this.snap(ax, az), [gx, gz] = this.snap(bx, bz);
    const n = this.n, start = sz * n + sx, goal = gz * n + gx;
    if (start === goal) return [{ x: bx, z: bz }];
    const g = new Float32Array(n * n).fill(Infinity), from = new Int32Array(n * n).fill(-1), closed = new Uint8Array(n * n);
    const open: number[] = [start]; // a small binary heap keyed by f
    const f = new Float32Array(n * n).fill(Infinity);
    g[start] = 0; f[start] = this.h(sx, sz, gx, gz);
    const push = (i: number) => { open.push(i); let k = open.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (f[open[p]] <= f[open[k]]) break; [open[p], open[k]] = [open[k], open[p]]; k = p; } };
    const pop = (): number => {
      const top = open[0], last = open.pop()!;
      if (open.length) { open[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < open.length && f[open[l]] < f[open[m]]) m = l; if (r < open.length && f[open[r]] < f[open[m]]) m = r; if (m === k) break; [open[m], open[k]] = [open[k], open[m]]; k = m; } }
      return top;
    };
    open.length = 0; push(start);
    while (open.length) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      const cx = cur % n, cz = (cur / n) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.isWalkable(nx, nz)) continue;
        if (dx && dz && (!this.isWalkable(cx + dx, cz) || !this.isWalkable(cx, cz + dz))) continue; // no corner cutting
        const ni = nz * n + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + (dx && dz ? 1.4142 : 1);
        if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; f[ni] = ng + this.h(nx, nz, gx, gz); push(ni); }
      }
    }
    if (from[goal] === -1) return null;
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = from[c]) cells.push(c);
    cells.reverse();
    const pts = cells.map((c) => this.center(c % n, (c / n) | 0));
    pts[0] = { x: ax, z: az };
    pts[pts.length - 1] = this.cellOf(bx, bz).join() === `${gx},${gz}` ? { x: bx, z: bz } : pts[pts.length - 1];
    return this.smooth(pts);
  }

  private h(x: number, z: number, gx: number, gz: number): number { const dx = Math.abs(x - gx), dz = Math.abs(z - gz); return dx + dz + (1.4142 - 2) * Math.min(dx, dz); }

  /** can a body walk the straight line? (sampled on the grid) */
  clearLine(a: P2, b: P2): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(len / 0.35));
    for (let i = 1; i < steps; i++) {
      const t = i / steps, [ix, iz] = this.cellOf(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!this.isWalkable(ix, iz)) return false;
    }
    return true;
  }

  private smooth(pts: P2[]): P2[] {
    if (pts.length <= 2) return pts;
    const out: P2[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.clearLine(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /** a clear line of sight between two eye positions (the world only) */
  see(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return !rayWorld(a, { x: dx / d, y: dy / d, z: dz / d }, d - 0.05, this.map.solids);
  }
}
