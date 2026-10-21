// ─────────────────────────────────────────────────────────
// Bohr model of an atom (elements 1–36).
//
// The model only names the element (and an ion charge).  The
// proton, neutron and electron counts and the shell arrangement
// come from the table below — never from the model.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec } from "./spec.js";
import { emptyBody, type Body } from "./layout.js";
import { circlePath, dot, text } from "./layoutQuant.js";

/** [symbol, name, mass number of the most abundant isotope] for Z = 1…36. */
export const ELEMENTS: Array<[string, string, number]> = [
  ["H", "Hydrogen", 1], ["He", "Helium", 4], ["Li", "Lithium", 7], ["Be", "Beryllium", 9], ["B", "Boron", 11],
  ["C", "Carbon", 12], ["N", "Nitrogen", 14], ["O", "Oxygen", 16], ["F", "Fluorine", 19], ["Ne", "Neon", 20],
  ["Na", "Sodium", 23], ["Mg", "Magnesium", 24], ["Al", "Aluminium", 27], ["Si", "Silicon", 28], ["P", "Phosphorus", 31],
  ["S", "Sulfur", 32], ["Cl", "Chlorine", 35], ["Ar", "Argon", 40], ["K", "Potassium", 39], ["Ca", "Calcium", 40],
  ["Sc", "Scandium", 45], ["Ti", "Titanium", 48], ["V", "Vanadium", 51], ["Cr", "Chromium", 52], ["Mn", "Manganese", 55],
  ["Fe", "Iron", 56], ["Co", "Cobalt", 59], ["Ni", "Nickel", 58], ["Cu", "Copper", 63], ["Zn", "Zinc", 64],
  ["Ga", "Gallium", 69], ["Ge", "Germanium", 74], ["As", "Arsenic", 75], ["Se", "Selenium", 80], ["Br", "Bromine", 79],
  ["Kr", "Krypton", 84],
];

/** Ground-state electrons per shell (K, L, M, N) — real configurations, incl. the Cr and Cu exceptions. */
export function shellsFor(z: number): number[] {
  if (z <= 2) return [z];
  if (z <= 10) return [2, z - 2];
  if (z <= 18) return [2, 8, z - 10];
  if (z <= 20) return [2, 8, 8, z - 18];
  const m: Record<number, [number, number]> = {
    21: [9, 2], 22: [10, 2], 23: [11, 2], 24: [13, 1], 25: [13, 2], 26: [14, 2], 27: [15, 2], 28: [16, 2], 29: [18, 1], 30: [18, 2],
  };
  if (m[z]) return [2, 8, ...m[z]];
  return [2, 8, 18, z - 28];
}

export function findElement(raw: string): number | undefined {
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const z = parseInt(s, 10);
    return z >= 1 && z <= ELEMENTS.length ? z : undefined;
  }
  const letters = s.replace(/[^A-Za-z]/g, "");
  const lower = letters.toLowerCase();
  const aliases: Record<string, string> = { aluminum: "aluminium", sulphur: "sulfur" };
  const name = aliases[lower] ?? lower;
  // Exact symbol ("Co") → name ("cobalt") → case-insensitive symbol ("co").
  const i = [
    ELEMENTS.findIndex(([sym]) => sym === letters),
    ELEMENTS.findIndex(([, n]) => n.toLowerCase() === name),
    ELEMENTS.findIndex(([sym]) => sym.toLowerCase() === lower),
  ].find((k) => k !== -1);
  return i === undefined ? undefined : i + 1;
}

/** Shells after an ion forms: cations lose outer electrons, anions gain them in the outer shell. */
export function ionShells(z: number, charge: number): number[] {
  const shells = [...shellsFor(z)];
  if (charge > 0) {
    let lose = charge;
    while (lose > 0 && shells.length) {
      const last = shells.length - 1;
      const take = Math.min(lose, shells[last]);
      shells[last] -= take;
      lose -= take;
      if (shells[last] === 0) shells.pop();
    }
  } else if (charge < 0) {
    shells[shells.length - 1] -= charge;
  }
  return shells;
}

export function validateAtom(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const a = spec.atom;
  if (!a) { critical.push('kind "atom" needs an "atom" block'); return spec; }
  const z = findElement(a.element);
  if (!z) { critical.push(`"${a.element}" is not an element this tutor can draw (Bohr models cover hydrogen → krypton, Z 1–36)`); return spec; }
  let charge = a.charge ?? 0;
  if (charge > 0 && charge >= z) {
    issues.push(`charge +${charge} would remove every electron → ignored`);
    charge = 0;
  }
  const outer = shellsFor(z).at(-1)!;
  if (charge < 0 && outer - charge > 8) {
    issues.push(`charge ${charge} would overfill the outer shell → ignored`);
    charge = 0;
  }
  return { ...spec, atom: { element: ELEMENTS[z - 1][0], charge: charge || undefined } };
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Anions take the "-ide" name: chlorine → chloride, oxygen → oxide, sulfur → sulfide. */
export function anionName(name: string): string {
  const special: Record<string, string> = { Oxygen: "Oxide", Sulfur: "Sulfide", Nitrogen: "Nitride", Phosphorus: "Phosphide", Hydrogen: "Hydride", Selenium: "Selenide", Arsenic: "Arsenide", Carbon: "Carbide" };
  return special[name] ?? name.replace(/ine$/, "ide");
}
export const ionSymbol = (sym: string, charge: number) =>
  charge ? `${sym}${Math.abs(charge) > 1 ? SUP[Math.abs(charge)] : ""}${charge > 0 ? "⁺" : "⁻"}` : sym;

export function layoutAtom(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const z = findElement(spec.atom!.element)!;
  const charge = spec.atom!.charge ?? 0;
  const [sym, name, mass] = ELEMENTS[z - 1];
  const shells = ionShells(z, charge);
  const neutrons = mass - z;
  const R0 = 34;
  const gapR = 40;

  // Nucleus.
  body.paths.push({ id: "x-nucleus", points: circlePath(0, 0, R0, 40), closed: true, smooth: true, role: "danger", fill: "danger", strokeWidth: 2, step: 1 });
  body.texts.push(text("x-nucleusl", `${z} p⁺\n${neutrons} n`, 0, -20, { align: "center", fontSize: 15, tone: "body" }));

  // Shells and electrons (outer-shell electrons highlighted).
  const shellStep = Math.min(2, maxStep);
  shells.forEach((count, k) => {
    const r = R0 + gapR * (k + 1);
    body.paths.push({ id: `x-shell${k}`, points: circlePath(0, 0, r, 72), closed: true, smooth: true, role: "muted", strokeWidth: 1.5, step: shellStep });
    const outer = k === shells.length - 1;
    for (let e = 0; e < count; e++) {
      const angle = -Math.PI / 2 + (e * 2 * Math.PI) / count + k * 0.35;
      body.paths.push(dot(`x-e${k}_${e}`, r * Math.cos(angle), r * Math.sin(angle), outer ? "accent" : "primary", outer ? Math.min(3, maxStep) : shellStep, 6));
    }
  });

  // Facts panel, all computed.
  const outerR = R0 + gapR * shells.length;
  const electrons = shells.reduce((s, n) => s + n, 0);
  const title = charge ? `${charge < 0 ? anionName(name) : name} ion (${ionSymbol(sym, charge)})` : `${name} (${sym})`;
  const lines = [
    `Atomic number ${z} → ${z} protons`,
    `Mass number ${mass} → ${neutrons} neutrons (${name.toLowerCase()}-${mass})`,
    `${electrons} electrons: ${shells.join(", ")}`,
    charge > 0 ? `Lost ${charge} electron${charge > 1 ? "s" : ""} → charge +${charge}` : charge < 0 ? `Gained ${-charge} electron${charge < -1 ? "s" : ""} → charge −${-charge}` : `Outer shell: ${shells.at(-1)} electron${shells.at(-1) === 1 ? "" : "s"}`,
  ];
  body.texts.push(text("x-atomt", title, outerR + 50, -outerR * 0.55, { fontSize: 20, tone: "body", w: 360 }));
  body.texts.push(text("x-atomf", lines.join("\n"), outerR + 50, -outerR * 0.55 + 36, { fontSize: 16, tone: "muted", step: Math.min(3, maxStep), w: 360 }));
  return body;
}
