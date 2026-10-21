// ─────────────────────────────────────────────────────────
// Maps: real country outlines (Natural Earth, public domain),
// projected and clipped by code.
//
// The model names countries and places; it never draws a
// coastline.  Country names are matched against the dataset
// (unknown names are dropped), well-known cities use built-in
// coordinates, and a marker claimed to be in a country must
// actually fall inside that country's outline.
// ─────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DiagramSpec, Role } from "./spec.js";
import { emptyBody, type Body, type Pt, type Tone } from "./layout.js";
import { PALETTE } from "./compiler.js";
import { measureBlock } from "./textMetrics.js";
import { clampStep, dot, text } from "./layoutQuant.js";

type MapBlock = NonNullable<DiagramSpec["map"]>;
type LonLat = [number, number];

export interface Country { id: string; name: string; rings: LonLat[][] }

let WORLD: Country[] | null = null;
export function countries(): Country[] {
  WORLD ??= (JSON.parse(readFileSync(fileURLToPath(new URL("./data/world.json", import.meta.url)), "utf8")) as { countries: Country[] }).countries;
  return WORLD;
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/\bthe\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const COUNTRY_ALIASES: Record<string, string> = {
  "usa": "United States of America", "us": "United States of America", "united states": "United States of America", "america": "United States of America", "u s a": "United States of America", "u s": "United States of America",
  "uk": "United Kingdom", "u k": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom",
  "czech republic": "Czechia", "democratic republic of congo": "Dem. Rep. Congo", "democratic republic of the congo": "Dem. Rep. Congo", "dr congo": "Dem. Rep. Congo", "drc": "Dem. Rep. Congo",
  "republic of congo": "Congo", "republic of the congo": "Congo", "congo brazzaville": "Congo", "ivory coast": "Côte d'Ivoire", "north macedonia": "Macedonia",
  "eswatini": "eSwatini", "swaziland": "eSwatini", "south sudan": "S. Sudan", "central african republic": "Central African Rep.", "dominican republic": "Dominican Rep.",
  "bosnia": "Bosnia and Herz.", "bosnia and herzegovina": "Bosnia and Herz.", "equatorial guinea": "Eq. Guinea", "western sahara": "W. Sahara", "uae": "United Arab Emirates",
  "burma": "Myanmar", "east timor": "Timor-Leste", "holland": "Netherlands", "persia": "Iran", "cape verde": "Cabo Verde", "vatican city": "Vatican", "holy see": "Vatican",
  "korea": "South Korea", "republic of korea": "South Korea", "dprk": "North Korea", "russian federation": "Russia", "ussr": "Russia", "soviet union": "Russia",
  "prc": "China", "people s republic of china": "China", "republic of china": "Taiwan", "turkiye": "Turkey", "solomon islands": "Solomon Is.", "marshall islands": "Marshall Is.",
  "antigua and barbuda": "Antigua and Barb.", "saint vincent and grenadines": "St. Vin. and Gren.", "falkland islands": "Falkland Is.", "faroe islands": "Faeroe Is.",
  "sao tome and principe": "São Tomé and Principe", "lao": "Laos", "viet nam": "Vietnam", "syrian arab republic": "Syria", "kyrgyz republic": "Kyrgyzstan",
};

export function findCountry(name: string): Country | undefined {
  const all = countries();
  const n = norm(name);
  const alias = COUNTRY_ALIASES[n];
  return all.find((c) => norm(c.name) === n) ?? (alias ? all.find((c) => c.name === alias) : undefined);
}

// ── Geometry helpers (lon/lat degrees) ─────────────────

export function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Approximate distance in degrees (longitude scaled by latitude) from a point to a country's outline. */
export function distanceToCountry(p: LonLat, c: Country): number {
  if (c.rings.some((r) => pointInRing(p, r))) return 0;
  const k = Math.cos((p[1] * Math.PI) / 180);
  let best = Infinity;
  for (const r of c.rings) {
    for (let i = 1; i < r.length; i++) {
      const ax = r[i - 1][0] * k, ay = r[i - 1][1], bx = r[i][0] * k, by = r[i][1];
      const px = p[0] * k, py = p[1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
  }
  return best;
}

/** Sutherland–Hodgman: clip a ring to a lon/lat rectangle. */
function clipRing(ring: LonLat[], [x0, x1, y0, y1]: [number, number, number, number]): LonLat[] {
  type Edge = [(p: LonLat) => boolean, (a: LonLat, b: LonLat) => LonLat];
  const lerpX = (a: LonLat, b: LonLat, x: number): LonLat => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const lerpY = (a: LonLat, b: LonLat, y: number): LonLat => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  const edges: Edge[] = [
    [(p) => p[0] >= x0, (a, b) => lerpX(a, b, x0)],
    [(p) => p[0] <= x1, (a, b) => lerpX(a, b, x1)],
    [(p) => p[1] >= y0, (a, b) => lerpY(a, b, y0)],
    [(p) => p[1] <= y1, (a, b) => lerpY(a, b, y1)],
  ];
  let out = ring;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cross(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

/** Rings that cross the antimeridian jump from +180 to −180; make their longitudes continuous. */
function unwrap(ring: LonLat[]): LonLat[] {
  let offset = 0;
  return ring.map((p, i) => {
    const jump = i > 0 ? p[0] - ring[i - 1][0] : 0;
    if (jump > 180) offset -= 360;
    else if (jump < -180) offset += 360;
    return [p[0] + offset, p[1]];
  });
}

/** Clip a ring to the view, handling rings that cross the antimeridian. */
function clipToView(ring: LonLat[], box: [number, number, number, number]): LonLat[][] {
  const r = unwrap(ring);
  const out: LonLat[][] = [];
  for (const shift of [0, 360, -360]) {
    const c = clipRing(r, [box[0] + shift, box[1] + shift, box[2], box[3]]);
    if (c.length >= 3) out.push(shift ? c.map(([x, y]) => [x - shift, y] as LonLat) : c);
  }
  return out;
}

// ── Places ─────────────────────────────────────────────

/** Well-known cities: [name, lat, lon, country (dataset name)]. Each is checked against the outlines in the self-test. */
export const GAZETTEER: Array<[string, number, number, string]> = [
  ["London", 51.51, -0.13, "United Kingdom"], ["Edinburgh", 55.95, -3.19, "United Kingdom"], ["Dublin", 53.35, -6.26, "Ireland"],
  ["Paris", 48.86, 2.35, "France"], ["Berlin", 52.52, 13.4, "Germany"], ["Madrid", 40.42, -3.7, "Spain"], ["Lisbon", 38.72, -9.14, "Portugal"],
  ["Rome", 41.9, 12.5, "Italy"], ["Venice", 45.44, 12.32, "Italy"], ["Vienna", 48.21, 16.37, "Austria"], ["Warsaw", 52.23, 21.01, "Poland"],
  ["Prague", 50.08, 14.44, "Czechia"], ["Budapest", 47.5, 19.04, "Hungary"], ["Bucharest", 44.43, 26.1, "Romania"], ["Athens", 37.98, 23.73, "Greece"],
  ["Amsterdam", 52.37, 4.9, "Netherlands"], ["Brussels", 50.85, 4.35, "Belgium"], ["Geneva", 46.2, 6.14, "Switzerland"], ["Zurich", 47.38, 8.54, "Switzerland"],
  ["Copenhagen", 55.68, 12.57, "Denmark"], ["Oslo", 59.91, 10.75, "Norway"], ["Stockholm", 59.33, 18.07, "Sweden"], ["Helsinki", 60.17, 24.94, "Finland"],
  ["Reykjavik", 64.15, -21.94, "Iceland"], ["Moscow", 55.76, 37.62, "Russia"], ["Saint Petersburg", 59.93, 30.34, "Russia"], ["Kyiv", 50.45, 30.52, "Ukraine"],
  ["Istanbul", 41.01, 28.98, "Turkey"], ["Ankara", 39.93, 32.86, "Turkey"], ["Cairo", 30.04, 31.24, "Egypt"], ["Alexandria", 31.2, 29.92, "Egypt"],
  ["Lagos", 6.52, 3.38, "Nigeria"], ["Nairobi", -1.29, 36.82, "Kenya"], ["Addis Ababa", 9.03, 38.74, "Ethiopia"], ["Kinshasa", -4.44, 15.27, "Dem. Rep. Congo"],
  ["Johannesburg", -26.2, 28.05, "South Africa"], ["Cape Town", -33.92, 18.42, "South Africa"], ["Accra", 5.6, -0.19, "Ghana"], ["Dakar", 14.72, -17.47, "Senegal"],
  ["Casablanca", 33.57, -7.59, "Morocco"], ["Algiers", 36.75, 3.06, "Algeria"], ["Tunis", 36.81, 10.18, "Tunisia"], ["Riyadh", 24.71, 46.68, "Saudi Arabia"],
  ["Mecca", 21.39, 39.86, "Saudi Arabia"], ["Dubai", 25.2, 55.27, "United Arab Emirates"], ["Tehran", 35.69, 51.39, "Iran"], ["Baghdad", 33.31, 44.36, "Iraq"],
  ["Damascus", 33.51, 36.28, "Syria"], ["Beirut", 33.89, 35.5, "Lebanon"], ["Kabul", 34.56, 69.21, "Afghanistan"], ["Tashkent", 41.3, 69.24, "Uzbekistan"],
  ["Karachi", 24.86, 67.01, "Pakistan"], ["Islamabad", 33.68, 73.05, "Pakistan"], ["New Delhi", 28.61, 77.21, "India"], ["Mumbai", 19.08, 72.88, "India"],
  ["Kolkata", 22.57, 88.36, "India"], ["Chennai", 13.08, 80.27, "India"], ["Bengaluru", 12.97, 77.59, "India"], ["Dhaka", 23.81, 90.41, "Bangladesh"],
  ["Kathmandu", 27.72, 85.32, "Nepal"], ["Colombo", 6.93, 79.86, "Sri Lanka"], ["Beijing", 39.9, 116.41, "China"], ["Shanghai", 31.23, 121.47, "China"],
  ["Hong Kong", 22.32, 114.17, "Hong Kong"], ["Tokyo", 35.68, 139.69, "Japan"], ["Seoul", 37.57, 126.98, "South Korea"], ["Ulaanbaatar", 47.89, 106.91, "Mongolia"],
  ["Bangkok", 13.76, 100.5, "Thailand"], ["Hanoi", 21.03, 105.85, "Vietnam"], ["Kuala Lumpur", 3.14, 101.69, "Malaysia"], ["Singapore", 1.35, 103.82, "Singapore"],
  ["Jakarta", -6.21, 106.85, "Indonesia"], ["Manila", 14.6, 120.98, "Philippines"], ["Sydney", -33.87, 151.21, "Australia"], ["Melbourne", -37.81, 144.96, "Australia"],
  ["Canberra", -35.28, 149.13, "Australia"], ["Auckland", -36.85, 174.76, "New Zealand"], ["Wellington", -41.29, 174.78, "New Zealand"],
  ["New York", 40.71, -74.01, "United States of America"], ["Washington, D.C.", 38.91, -77.04, "United States of America"], ["Chicago", 41.88, -87.63, "United States of America"],
  ["Los Angeles", 34.05, -118.24, "United States of America"], ["San Francisco", 37.77, -122.42, "United States of America"], ["Toronto", 43.65, -79.38, "Canada"],
  ["Ottawa", 45.42, -75.7, "Canada"], ["Vancouver", 49.28, -123.12, "Canada"], ["Mexico City", 19.43, -99.13, "Mexico"], ["Havana", 23.11, -82.37, "Cuba"],
  ["Bogotá", 4.71, -74.07, "Colombia"], ["Caracas", 10.48, -66.9, "Venezuela"], ["Quito", -0.18, -78.47, "Ecuador"], ["Lima", -12.05, -77.04, "Peru"],
  ["Santiago", -33.45, -70.67, "Chile"], ["Buenos Aires", -34.6, -58.38, "Argentina"], ["São Paulo", -23.55, -46.63, "Brazil"], ["Rio de Janeiro", -22.91, -43.17, "Brazil"],
  ["Brasília", -15.79, -47.88, "Brazil"],
];
const CITY_ALIASES: Record<string, string> = {
  "delhi": "New Delhi", "bombay": "Mumbai", "calcutta": "Kolkata", "madras": "Chennai", "bangalore": "Bengaluru", "peking": "Beijing", "constantinople": "Istanbul",
  "byzantium": "Istanbul", "washington": "Washington, D.C.", "washington dc": "Washington, D.C.", "nyc": "New York", "new york city": "New York", "la": "Los Angeles",
  "st petersburg": "Saint Petersburg", "leningrad": "Saint Petersburg", "kiev": "Kyiv", "rio": "Rio de Janeiro", "sao paulo": "São Paulo", "bogota": "Bogotá", "brasilia": "Brasília",
};
export function findCity(label: string): [string, number, number, string] | undefined {
  const n = norm(label.replace(/\(.*?\)/g, ""));
  const alias = CITY_ALIASES[n];
  return GAZETTEER.find(([name]) => norm(name) === n || (alias !== undefined && name === alias));
}

// ── Validation / repair ────────────────────────────────

export function validateMap(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const m = spec.map;
  if (!m) { critical.push('kind "map" needs a "map" block'); return spec; }
  const seen = new Set<string>();
  const countryList = (m.countries ?? []).flatMap((c) => {
    const hit = findCountry(c.name);
    if (!hit) { issues.push(`"${c.name}" is not a country in the map data → not highlighted`); return []; }
    if (seen.has(hit.name)) return [];
    seen.add(hit.name);
    return [{ ...c, name: hit.name, label: c.label ?? c.name }];
  });
  const markers = (m.markers ?? []).flatMap((mk) => {
    const city = findCity(mk.label);
    if (city) {
      const [, lat, lon] = city;
      if (mk.lat !== undefined && mk.lon !== undefined && Math.hypot(mk.lat - lat, mk.lon - lon) > 1.5) {
        issues.push(`coordinates given for ${mk.label} were wrong → corrected to (${lat}, ${lon})`);
      }
      return [{ ...mk, lat, lon, country: city[3] }];
    }
    if (mk.lat === undefined || mk.lon === undefined || Math.abs(mk.lat) > 90 || Math.abs(mk.lon) > 180) {
      issues.push(`marker "${mk.label}" has no valid coordinates → dropped`);
      return [];
    }
    if (mk.country) {
      const c = findCountry(mk.country);
      if (c && distanceToCountry([mk.lon, mk.lat], c) > 1) {
        issues.push(`marker "${mk.label}" (${mk.lat}, ${mk.lon}) is not in ${c.name} → dropped`);
        return [];
      }
    }
    return [mk];
  });
  const labels = new Set(markers.map((mk) => mk.label.toLowerCase()));
  const routes = (m.routes ?? []).filter((r) => {
    const ok = labels.has(r.from.toLowerCase()) && labels.has(r.to.toLowerCase());
    if (!ok) issues.push(`route ${r.from} → ${r.to} refers to a place that isn't a marker → dropped`);
    return ok;
  });
  if (!countryList.length && !markers.length && !m.region) critical.push("a map needs a region, highlighted countries or markers");
  return { ...spec, map: { ...m, countries: countryList, markers, routes } };
}

// ── Layout ─────────────────────────────────────────────

const REGION_BOXES: Record<string, [number, number, number, number]> = {
  world: [-180, 180, -58, 84], europe: [-25, 45, 34, 72], asia: [25, 150, -12, 62], africa: [-20, 55, -36, 38],
  north_america: [-170, -50, 5, 75], south_america: [-85, -30, -57, 14], oceania: [110, 180, -50, 0],
  middle_east: [25, 65, 10, 43], south_asia: [60, 98, 4, 38], east_asia: [95, 150, 15, 55],
};

function bboxOf(rings: LonLat[][]): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [x0, x1, y0, y1];
}

/** View box: the named region, or a padded box around what must be shown. */
export function viewBox(m: MapBlock): [number, number, number, number] {
  const content = contentBox(m);
  if (!m.region) return content ?? REGION_BOXES.world;
  const region = REGION_BOXES[m.region];
  // Models often say "world" for a regional story: zoom to the content when it fills under a quarter of the region.
  if (content) {
    const area = (b: [number, number, number, number]) => (b[1] - b[0]) * (b[3] - b[2]);
    if (area(content) < 0.25 * area(region)) return content;
  }
  return region;
}

function contentBox(m: MapBlock): [number, number, number, number] | null {
  const rings: LonLat[][] = [];
  for (const c of m.countries ?? []) {
    const country = findCountry(c.name)!;
    // Only the country's main landmass counts (overseas islands would zoom out to the whole world).
    const main = country.rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    rings.push(main);
  }
  if (m.markers?.length) rings.push(m.markers.map((mk) => [mk.lon!, mk.lat!] as LonLat));
  if (!rings.length) return null;
  let [x0, x1, y0, y1] = bboxOf(rings);
  const padX = Math.max(4, (x1 - x0) * 0.18), padY = Math.max(3, (y1 - y0) * 0.18);
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  // Keep a sensible minimum extent and aspect ratio.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const w = Math.max(x1 - x0, 16, (y1 - y0) * 1.2), h = Math.max(y1 - y0, 10, w / 2.2);
  return [Math.max(-180, cx - w / 2), Math.min(180, cx + w / 2), Math.max(-85, cy - h / 2), Math.min(85, cy + h / 2)];
}

function ringArea(r: LonLat[] | Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}

/** A point well inside a polygon (coarse pole of inaccessibility) for the label. */
function interiorPoint(ring: Pt[]): Pt {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const inside = (p: Pt) => pointInRing(p as LonLat, ring as LonLat[]);
  const edgeDist = (p: Pt) => {
    let best = Infinity;
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
    return best;
  };
  let best: Pt = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = -1;
  const N = 14;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p: Pt = [x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N];
    if (!inside(p)) continue;
    const d = edgeDist(p);
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Natural Earth I projection (world maps). */
function naturalEarth(lon: number, lat: number): Pt {
  const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180;
  const p2 = p * p, p4 = p2 * p2;
  return [
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

const SEA = "#dbeefe";
const LAND = "#ced4da";

interface Rect { x: number; y: number; w: number; h: number }
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function layoutMap(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const m = spec.map!;
  const box = viewBox(m);
  const world = box[1] - box[0] >= 300;
  const lat0 = ((box[2] + box[3]) / 2) * (Math.PI / 180);
  const raw = (lon: number, lat: number): Pt => (world ? naturalEarth(lon, lat) : [(lon * Math.PI) / 180 * Math.cos(lat0), (lat * Math.PI) / 180]);
  // Scale the view to ~860 px wide (or ~560 px tall for tall regions).
  const corners = [raw(box[0], box[2]), raw(box[1], box[3]), raw(box[0], box[3]), raw(box[1], box[2])];
  if (world) corners.push(raw(0, box[2]), raw(0, box[3]));
  const rx0 = world ? raw(-180, 0)[0] : Math.min(...corners.map((c) => c[0]));
  const rx1 = world ? raw(180, 0)[0] : Math.max(...corners.map((c) => c[0]));
  const ry0 = Math.min(...corners.map((c) => c[1])), ry1 = Math.max(...corners.map((c) => c[1]));
  const k = Math.min(860 / (rx1 - rx0), 560 / (ry1 - ry0));
  const P = (lon: number, lat: number): Pt => {
    const [x, y] = raw(lon, lat);
    return [(x - rx0) * k, (ry1 - y) * k];
  };
  const W = (rx1 - rx0) * k, H = (ry1 - ry0) * k;

  // Sea. Light-theme colours (the dark theme inverts them): pale blue sea, mid-grey land, vivid highlights.
  body.paths.push({ id: "x-sea", points: [[0, 0], [W, 0], [W, H], [0, H], [0, 0]], closed: true, role: "primary", fillColor: SEA, strokeWidth: 1, step: 1 });

  const highlight = new Map((m.countries ?? []).map((c) => [c.name, c]));
  const labelSpots: Array<{ name: string; label: string; role: Role; step: number; at: Pt; area: number }> = [];
  let ringN = 0;
  for (const c of countries()) {
    const [cx0, cx1, cy0, cy1] = bboxOf(c.rings);
    if (cx1 < box[0] || cx0 > box[1] || cy1 < box[2] || cy0 > box[3]) continue;
    const h = highlight.get(c.name);
    const role: Role = h?.role ?? "warning";
    const step = h ? clampStep(h.step, maxStep) : 1;
    let biggest: Pt[] | null = null, biggestArea = 0;
    for (const clipped of c.rings.flatMap((ring) => clipToView(ring, box))) {
      const pts = clipped.map(([lon, lat]) => P(lon, lat));
      const area = ringArea(pts);
      if (area < (h ? 0.5 : 4)) continue;
      pts.push(pts[0]);
      // Base land first (step 1); highlighted countries are re-drawn on top at their own step.
      body.paths.push({ id: `x-land${ringN++}`, points: pts, closed: true, role: "muted", fillColor: LAND, strokeWidth: 1, step: 1 });
      if (h) body.paths.push({ id: `x-hl${ringN++}`, points: pts, closed: true, role, fillColor: PALETTE[role].stroke, opacity: 70, strokeWidth: 1.5, step });
      if (area > biggestArea) { biggestArea = area; biggest = pts; }
    }
    if (h && biggest) labelSpots.push({ name: c.name, label: h.label ?? c.name, role, step, at: interiorPoint(biggest), area: biggestArea });
  }
  body.paths.push({ id: "x-frame", points: [[0, 0], [W, 0], [W, H], [0, H], [0, 0]], role: "muted", strokeWidth: 1.5, step: 1 });

  // Labels and markers, placed so they don't collide.
  const taken: Rect[] = [];
  const place = (id: string, label: string, anchor: Pt, role: Tone, step: number, candidates: Pt[], fontSize = 14, required = false) => {
    const block = measureBlock(label, fontSize, 150);
    const rectAt = ([ox, oy]: Pt) => ({ x: anchor[0] + ox - (ox < 0 ? block.width : ox === 0 ? block.width / 2 : 0), y: anchor[1] + oy, w: block.width, h: block.height });
    const inside = (r: Rect) => r.x >= 2 && r.y >= 2 && r.x + r.w <= W - 2 && r.y + r.h <= H - 2;
    // A free spot if there is one; a marker's name is shown even when everything nearby is crowded.
    const r = candidates.map(rectAt).find((c) => inside(c) && !taken.some((t) => hits(t, c))) ?? (required ? candidates.map(rectAt).find(inside) ?? rectAt(candidates[0]) : undefined);
    if (!r) return false;
    taken.push(r);
    body.texts.push(text(id, block.text, r.x, r.y, { fontSize, tone: role, step, w: 150 }));
    return true;
  };

  const markerPts = (m.markers ?? []).map((mk) => ({ mk, at: P(mk.lon!, mk.lat!) }));
  for (const { at } of markerPts) taken.push({ x: at[0] - 6, y: at[1] - 6, w: 12, h: 12 });
  (m.routes ?? []).forEach((r, i) => {
    const a = markerPts.find((p) => p.mk.label.toLowerCase() === r.from.toLowerCase())!.at;
    const b = markerPts.find((p) => p.mk.label.toLowerCase() === r.to.toLowerCase())!.at;
    const s = clampStep(r.step, maxStep);
    const role = r.role ?? "danger";
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const ctrl: Pt = [(a[0] + b[0]) / 2 - (dy / l) * l * 0.18, (a[1] + b[1]) / 2 + (dx / l) * l * 0.18];
    const curve: Pt[] = [];
    for (let t = 0; t <= 1.0001; t += 0.1) curve.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * ctrl[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * ctrl[1] + t * t * b[1]]);
    // Stop short of the destination dot.
    const end = curve[curve.length - 1], prev = curve[curve.length - 2];
    const el = Math.hypot(end[0] - prev[0], end[1] - prev[1]) || 1;
    curve[curve.length - 1] = [end[0] - ((end[0] - prev[0]) / el) * 8, end[1] - ((end[1] - prev[1]) / el) * 8];
    body.paths.push({ id: `x-route${i}`, points: curve, smooth: true, role, strokeWidth: 2.5, arrowEnd: true, step: s });
    // Keep labels off the route line.
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * ctrl[0] + t * t * b[0], y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * ctrl[1] + t * t * b[1];
      taken.push({ x: x - 3, y: y - 3, w: 6, h: 6 });
    }
    if (r.label) place(`x-routel${i}`, r.label, ctrl, role, s, [[0, -22], [8, -10], [-8, -10], [0, 6]]);
  });
  markerPts.forEach(({ mk, at }, i) => {
    const s = clampStep(mk.step, maxStep);
    const role = mk.role ?? "danger";
    body.paths.push(dot(`x-mk${i}`, at[0], at[1], role, s, 5));
    place(`x-mkl${i}`, mk.label, at, role, s, [[9, -11], [-9, -11], [0, -30], [0, 8], [9, 4], [-9, -26]], 17, true);
  });
  labelSpots.forEach((l, i) => {
    const small = l.area < 400;
    if (small) body.paths.push(dot(`x-hlmk${i}`, l.at[0], l.at[1], l.role, l.step, 4));
    place(`x-hll${i}`, l.label, l.at, "body", l.step, small ? [[7, -10], [-7, -10], [0, 6], [0, -26]] : [[0, -10], [0, 4], [0, -24], [8, -10], [-8, -10]], 16);
  });
  body.texts.push(text("x-mapsrc", "Map data: Natural Earth", W - 4 - measureBlock("Map data: Natural Earth", 11, 200).width, H + 4, { fontSize: 11, tone: "muted" }));
  return body;
}
