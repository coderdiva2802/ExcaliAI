// ─────────────────────────────────────────────────────────
// Builds src/diagram/data/world.json — compact country outlines
// for the "map" diagram kind.
//
// Source: Natural Earth 1:50m admin-0 countries (public domain),
// via the world-atlas TopoJSON package (ISC).  Run once:
//   npm i --no-save world-atlas@2.0.2   (anywhere)
//   node scripts/build-world-map.mjs <path>/world-atlas/countries-50m.json
// The output is committed; there is no runtime dependency.
// ─────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/build-world-map.mjs <countries-50m.json>");
  process.exit(1);
}
const topo = JSON.parse(readFileSync(input, "utf8"));
const { scale, translate } = topo.transform;

// Decode delta-encoded, quantized arcs into [lon, lat] arrays.
const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
});
const arcPoints = (i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
const ring = (indices) => {
  const pts = [];
  indices.forEach((i, k) => {
    const a = arcPoints(i);
    pts.push(...(k === 0 ? a : a.slice(1)));
  });
  return pts;
};

// Douglas–Peucker simplification (degrees).
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best !== -1 && bestD > tol) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Closed rings start and end on the same point, so split at the farthest point first. */
function simplifyRing(pts, tol) {
  let far = 0, farD = -1;
  pts.forEach(([x, y], i) => {
    const d = Math.hypot(x - pts[0][0], y - pts[0][1]);
    if (d > farD) { farD = d; far = i; }
  });
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify(pts.slice(far), tol);
  return [...a, ...b.slice(1)];
}

const area = (pts) => {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(s / 2);
};

const TOL = 0.06;
const r2 = (v) => Math.round(v * 100) / 100;
const countries = [];
for (const g of topo.objects.countries.geometries) {
  if (!g.arcs || !g.properties?.name) continue;
  const polys = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
  let rings = polys.map((p) => ring(p[0])); // outer rings only (holes are negligible at this scale)
  const biggest = Math.max(...rings.map(area));
  rings = rings
    .filter((r) => area(r) === biggest || area(r) > 0.05)
    .map((r) => simplifyRing(r, TOL).map(([x, y]) => [r2(x), r2(y)]))
    .filter((r) => r.length >= 4);
  if (!rings.length) continue;
  countries.push({ id: g.id ?? "", name: g.properties.name, rings });
}
countries.sort((a, b) => a.name.localeCompare(b.name));

const out = join(dirname(fileURLToPath(import.meta.url)), "../src/diagram/data/world.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    source: "Natural Earth 1:50m admin-0 countries (public domain) via world-atlas 2.0.2 (ISC); simplified",
    countries,
  })
);
const points = countries.reduce((s, c) => s + c.rings.reduce((t, r) => t + r.length, 0), 0);
console.log(`${countries.length} countries, ${points} points → ${out}`);
