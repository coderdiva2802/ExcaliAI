// ─────────────────────────────────────────────────────────
// Chemistry: molecular structures and reactions.
//
// The model names molecules and gives SMILES; it never draws
// them.  OpenChemLib parses the SMILES and computes a proper 2-D
// layout.  Common molecules come from a vetted dictionary that
// overrides the model's SMILES (a wrong SMILES would draw the
// wrong molecule).  Formulas, molar masses and reaction balance
// are computed — a stated formula that contradicts the structure
// is corrected, and unbalanced equations are re-balanced or rejected.
// ─────────────────────────────────────────────────────────

import { Molecule } from "openchemlib";
import type { DiagramSpec } from "./spec.js";
import { emptyBody, type Body, type Pt } from "./layout.js";
import { measureBlock } from "./textMetrics.js";
import { clampStep, text } from "./layoutQuant.js";

type ChemBlock = NonNullable<DiagramSpec["chemistry"]>;
type Mol = ChemBlock["molecules"][number];

/** name → [SMILES, conventional display formula]. Each entry is checked against OpenChemLib in the self-test. */
export const KNOWN_MOLECULES: Record<string, [string, string]> = {
  water: ["O", "H2O"],
  hydrogen: ["[H][H]", "H2"],
  oxygen: ["O=O", "O2"],
  nitrogen: ["N#N", "N2"],
  chlorine: ["ClCl", "Cl2"],
  fluorine: ["FF", "F2"],
  bromine: ["BrBr", "Br2"],
  "carbon dioxide": ["O=C=O", "CO2"],
  "carbon monoxide": ["[C-]#[O+]", "CO"],
  methane: ["C", "CH4"],
  ethane: ["CC", "C2H6"],
  propane: ["CCC", "C3H8"],
  butane: ["CCCC", "C4H10"],
  pentane: ["CCCCC", "C5H12"],
  hexane: ["CCCCCC", "C6H14"],
  octane: ["CCCCCCCC", "C8H18"],
  ethene: ["C=C", "C2H4"],
  propene: ["CC=C", "C3H6"],
  ethyne: ["C#C", "C2H2"],
  methanol: ["CO", "CH3OH"],
  ethanol: ["CCO", "C2H5OH"],
  propanol: ["CCCO", "C3H7OH"],
  "ethanoic acid": ["CC(=O)O", "CH3COOH"],
  "methanoic acid": ["OC=O", "HCOOH"],
  propanone: ["CC(=O)C", "C3H6O"],
  methanal: ["C=O", "CH2O"],
  ethanal: ["CC=O", "C2H4O"],
  "ethyl ethanoate": ["CCOC(C)=O", "C4H8O2"],
  benzene: ["c1ccccc1", "C6H6"],
  toluene: ["Cc1ccccc1", "C7H8"],
  phenol: ["Oc1ccccc1", "C6H5OH"],
  cyclohexane: ["C1CCCCC1", "C6H12"],
  glucose: ["OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O", "C6H12O6"],
  caffeine: ["CN1C=NC2=C1C(=O)N(C(=O)N2C)C", "C8H10N4O2"],
  aspirin: ["CC(=O)OC1=CC=CC=C1C(=O)O", "C9H8O4"],
  paracetamol: ["CC(=O)NC1=CC=C(O)C=C1", "C8H9NO2"],
  ammonia: ["N", "NH3"],
  "hydrogen peroxide": ["OO", "H2O2"],
  ozone: ["[O-][O+]=O", "O3"],
  "hydrogen chloride": ["Cl", "HCl"],
  "sulfuric acid": ["OS(=O)(=O)O", "H2SO4"],
  "nitric acid": ["O[N+](=O)[O-]", "HNO3"],
  "carbonic acid": ["OC(=O)O", "H2CO3"],
  "sodium chloride": ["[Na+].[Cl-]", "NaCl"],
  "sodium hydroxide": ["[Na+].[OH-]", "NaOH"],
  "calcium carbonate": ["[Ca+2].[O-]C([O-])=O", "CaCO3"],
  "sulfur dioxide": ["O=S=O", "SO2"],
  glycine: ["NCC(=O)O", "C2H5NO2"],
  alanine: ["C[C@@H](C(=O)O)N", "C3H7NO2"],
  urea: ["NC(=O)N", "CO(NH2)2"],
  glycerol: ["OCC(O)CO", "C3H8O3"],
  "lactic acid": ["CC(O)C(=O)O", "C3H6O3"],
  "citric acid": ["OC(=O)CC(O)(C(=O)O)CC(=O)O", "C6H8O7"],
};

const ALIASES: Record<string, string> = {
  "h2o": "water", "co2": "carbon dioxide", "ch4": "methane", "o2": "oxygen", "h2": "hydrogen", "n2": "nitrogen", "nh3": "ammonia",
  "ethylene": "ethene", "acetylene": "ethyne", "propylene": "propene", "methyl alcohol": "methanol", "ethyl alcohol": "ethanol", "alcohol": "ethanol",
  "acetic acid": "ethanoic acid", "vinegar": "ethanoic acid", "formic acid": "methanoic acid", "acetone": "propanone",
  "formaldehyde": "methanal", "acetaldehyde": "ethanal", "ethyl acetate": "ethyl ethanoate", "methylbenzene": "toluene",
  "acetylsalicylic acid": "aspirin", "acetaminophen": "paracetamol", "hydrochloric acid": "hydrogen chloride", "hcl": "hydrogen chloride",
  "sulphuric acid": "sulfuric acid", "h2so4": "sulfuric acid", "hno3": "nitric acid", "table salt": "sodium chloride", "salt": "sodium chloride",
  "nacl": "sodium chloride", "naoh": "sodium hydroxide", "caustic soda": "sodium hydroxide", "limestone": "calcium carbonate", "caco3": "calcium carbonate",
  "sulphur dioxide": "sulfur dioxide", "so2": "sulfur dioxide", "glycerine": "glycerin", "glycerin": "glycerol", "d-glucose": "glucose", "dextrose": "glucose",
  "propan-1-ol": "propanol", "1-propanol": "propanol", "dihydrogen monoxide": "water", "co": "carbon monoxide", "h2o2": "hydrogen peroxide", "o3": "ozone",
};

export function lookupMolecule(name: string): { key: string; smiles: string; display: string } | undefined {
  let k = name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim();
  k = ALIASES[k] ?? k;
  k = ALIASES[k] ?? k;
  const hit = KNOWN_MOLECULES[k];
  return hit ? { key: k, smiles: hit[0], display: hit[1] } : undefined;
}

// ── Formulas ───────────────────────────────────────────

export type Counts = Record<string, number>;

/** Element counts of a formula like "CH3COOH", "CO(NH2)2", "C6H12O6" (charges ignored). */
export function parseFormula(formula: string): Counts | null {
  const s = formula.replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080)).replace(/[\s⁺⁻+\-^]/g, "").replace(/·.*$/, "");
  let i = 0;
  const group = (): Counts | null => {
    const out: Counts = {};
    while (i < s.length && s[i] !== ")") {
      let part: Counts | null;
      if (s[i] === "(") {
        i++;
        part = group();
        if (!part || s[i] !== ")") return null;
        i++;
      } else {
        const m = /^[A-Z][a-z]?/.exec(s.slice(i));
        if (!m) return null;
        i += m[0].length;
        part = { [m[0]]: 1 };
      }
      const n = /^\d+/.exec(s.slice(i));
      const mult = n ? parseInt(n[0], 10) : 1;
      if (n) i += n[0].length;
      for (const [el, c] of Object.entries(part)) out[el] = (out[el] ?? 0) + c * mult;
    }
    return out;
  };
  const counts = group();
  return counts && i === s.length && Object.keys(counts).length ? counts : null;
}

const sameCounts = (a: Counts, b: Counts) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0) === (b[k] ?? 0));
};

const SUB = "₀₁₂₃₄₅₆₇₈₉";
export const subscript = (formula: string) => formula.replace(/(?<=[A-Za-z)\]])\d+/g, (d) => [...d].map((c) => SUB[+c]).join(""));

export interface ParsedMolecule { mol: Molecule; formula: string; counts: Counts; weight: number; heavyAtoms: number }

export function parseSmiles(smiles: string): ParsedMolecule | null {
  try {
    const mol = Molecule.fromSmiles(smiles);
    const mf = mol.getMolecularFormula();
    const counts = parseFormula(mf.formula);
    if (!counts) return null;
    let heavy = 0;
    for (let a = 0; a < mol.getAllAtoms(); a++) if (mol.getAtomicNo(a) !== 1) heavy++;
    return { mol, formula: mf.formula, counts, weight: mf.relativeWeight, heavyAtoms: heavy };
  } catch {
    return null;
  }
}

// ── Reaction balancing ─────────────────────────────────

/** Smallest coefficients (1–8 each) that balance every element, or null. */
export function balance(reactants: Counts[], products: Counts[]): number[] | null {
  const species = [...reactants, ...products];
  if (species.length > 6) return null;
  const elements = [...new Set(species.flatMap((c) => Object.keys(c)))];
  const coef = new Array(species.length).fill(1);
  let best: number[] | null = null;
  let bestSum = Infinity;
  const check = () => elements.every((el) => {
    let net = 0;
    species.forEach((c, k) => { net += (k < reactants.length ? 1 : -1) * coef[k] * (c[el] ?? 0); });
    return net === 0;
  });
  const walk = (k: number, sum: number) => {
    if (sum >= bestSum) return;
    if (k === species.length) {
      if (check()) { best = [...coef]; bestSum = sum; }
      return;
    }
    for (let c = 1; c <= 8; c++) { coef[k] = c; walk(k + 1, sum + c); }
    coef[k] = 1;
  };
  walk(0, 0);
  return best;
}

// ── Validation / repair ────────────────────────────────

export function validateChemistry(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const c = spec.chemistry;
  if (!c) { critical.push('kind "molecule" needs a "chemistry" block'); return spec; }
  const molecules: Mol[] = [];
  for (const m of c.molecules) {
    const known = lookupMolecule(m.name);
    let smiles = m.smiles;
    if (known) {
      const theirs = smiles ? parseSmiles(smiles) : null;
      const ours = parseSmiles(known.smiles)!;
      if (smiles && (!theirs || !sameCounts(theirs.counts, ours.counts))) {
        issues.push(`SMILES given for ${m.name} does not match ${known.key} → the verified structure is drawn`);
      }
      smiles = known.smiles;
    }
    if (!smiles) {
      issues.push(`"${m.name}" has no SMILES and is not a known molecule → dropped`);
      continue;
    }
    const parsed = parseSmiles(smiles);
    if (!parsed) {
      issues.push(`SMILES "${smiles}" for ${m.name} is not valid → dropped`);
      continue;
    }
    if (parsed.heavyAtoms > 50) {
      issues.push(`${m.name} is too large to draw legibly (${parsed.heavyAtoms} heavy atoms) → dropped`);
      continue;
    }
    const display = known?.display ?? parsed.formula;
    if (m.formula) {
      const stated = parseFormula(m.formula);
      if (!stated || !sameCounts(stated, parsed.counts)) {
        issues.push(`stated formula ${m.formula} for ${m.name} contradicts its structure → shown as ${display}`);
      }
    }
    molecules.push({ ...m, smiles, formula: display });
  }
  if (!molecules.length) { critical.push("no drawable molecules (each needs a valid SMILES)"); return spec; }

  // Reactions: everything before the first product is a reactant.
  if (molecules.some((m) => m.role)) {
    const firstProduct = molecules.findIndex((m) => m.role === "product");
    molecules.forEach((m, i) => { m.role ??= firstProduct === -1 || i < firstProduct ? "reactant" : "product"; });
    const reactants = molecules.filter((m) => m.role === "reactant");
    const products = molecules.filter((m) => m.role === "product");
    if (!reactants.length || !products.length) {
      critical.push("a reaction needs at least one reactant and one product");
    } else {
      const countsOf = (m: Mol) => parseSmiles(m.smiles!)!.counts;
      const totals = (list: Mol[]) => {
        const t: Counts = {};
        for (const m of list) for (const [el, n] of Object.entries(countsOf(m))) t[el] = (t[el] ?? 0) + n * (m.coefficient ?? 1);
        return t;
      };
      if (!sameCounts(totals(reactants), totals(products))) {
        const fixed = balance(reactants.map(countsOf), products.map(countsOf));
        if (fixed) {
          [...reactants, ...products].forEach((m, k) => { m.coefficient = fixed[k]; });
          issues.push("the equation was not balanced → coefficients corrected");
        } else {
          critical.push("the reaction cannot be balanced with these reactants and products — check the species");
        }
      }
    }
  }
  return { ...spec, chemistry: { ...c, molecules } };
}

// ── Layout ─────────────────────────────────────────────

const BOND = 46;
const FONT = 18;

interface AtomView { x: number; y: number; label: string | null; hw: number; hh: number }

function drawMolecule(body: Body, m: Mol, prefix: string, step: number, showH: boolean | undefined): { x0: number; x1: number; y0: number; y1: number } {
  const parsed = parseSmiles(m.smiles!)!;
  const mol = parsed.mol;
  const explicitH = showH ?? parsed.heavyAtoms <= 6;
  if (explicitH) mol.addImplicitHydrogens();
  mol.inventCoordinates({ keepHydrogens: explicitH, seed: 0 });
  mol.ensureHelperArrays(Molecule.cHelperNeighbours);
  const n = mol.getAllAtoms();
  const scale = BOND / (mol.getAverageBondLength(false) || 1);
  const skeletal = !explicitH && parsed.heavyAtoms > 14;

  const atoms: AtomView[] = [];
  for (let a = 0; a < n; a++) {
    const el = mol.getAtomLabel(a);
    const hs = explicitH ? 0 : mol.getImplicitHydrogens(a);
    const charge = mol.getAtomCharge(a);
    const isC = el === "C";
    const hidden = isC && skeletal && charge === 0 && mol.getConnAtoms(a) > 0;
    let label: string | null = null;
    if (!hidden) {
      const sup = charge ? (Math.abs(charge) > 1 ? "⁰¹²³⁴⁵⁶⁷⁸⁹"[Math.abs(charge)] : "") + (charge > 0 ? "⁺" : "⁻") : "";
      label = subscript(el + (hs ? `H${hs > 1 ? hs : ""}` : "")) + sup;
    }
    const w = label ? measureBlock(label, FONT, 200).width : 0;
    atoms.push({ x: mol.getAtomX(a) * scale, y: mol.getAtomY(a) * scale, label, hw: w / 2 + 6, hh: 13 });
  }
  // Disconnected ions (e.g. [Na+].[Cl-]) get coordinates on top of each other in some layouts: spread them.
  if (n > 1 && mol.getAllBonds() === 0) atoms.forEach((a, i) => { a.x = i * 60; a.y = 0; });

  const clip = (from: AtomView, to: AtomView): Pt => {
    if (!from.label) return [from.x, from.y];
    const dx = to.x - from.x, dy = to.y - from.y;
    const t = Math.min(Math.abs(dx) > 1e-9 ? from.hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? from.hh / Math.abs(dy) : Infinity, 0.45);
    return [from.x + dx * t, from.y + dy * t];
  };
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const A = atoms[mol.getBondAtom(0, b)], B = atoms[mol.getBondAtom(1, b)];
    const p = clip(A, B), q = clip(B, A);
    const order = Math.min(3, Math.max(1, mol.getBondOrder(b)));
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    const offsets = order === 1 ? [0] : order === 2 ? [-3.5, 3.5] : [-5, 0, 5];
    offsets.forEach((o, k) => {
      body.paths.push({ id: `${prefix}b${b}_${k}`, points: [[p[0] + nx * o, p[1] + ny * o], [q[0] + nx * o, q[1] + ny * o]], role: "ink", strokeWidth: 2, step });
    });
  }
  atoms.forEach((a, i) => {
    if (!a.label) return;
    const tone = a.label.startsWith("O") ? "danger" : a.label.startsWith("N") && !a.label.startsWith("Na") ? "primary" : a.label.startsWith("Cl") || a.label.startsWith("F") ? "success" : a.label.startsWith("S") && !a.label.startsWith("Si") ? "warning" : "body";
    body.texts.push(text(`${prefix}a${i}`, a.label, a.x, a.y - 12, { align: "center", fontSize: FONT, tone, step }));
  });
  const xs = atoms.map((a) => [a.x - a.hw, a.x + a.hw]).flat(), ys = atoms.map((a) => [a.y - a.hh, a.y + a.hh]).flat();
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

export function layoutMolecules(spec: DiagramSpec, maxStep: number): Body {
  const c = spec.chemistry!;
  const out = emptyBody();
  const isReaction = c.molecules.some((m) => m.role === "product");
  let x = 0;
  const parts: string[] = [];
  c.molecules.forEach((m, i) => {
    const s = clampStep(m.step, maxStep);
    // Draw into a scratch body, then translate so molecules sit in a row centred on y = 0.
    const scratch = emptyBody();
    const bb = drawMolecule(scratch, m, `x-m${i}`, s, c.showHydrogens);
    if (isReaction && i > 0) {
      const prev = c.molecules[i - 1];
      if (prev.role === "reactant" && m.role === "product") {
        out.paths.push({ id: "x-rxn-arrow", points: [[x + 10, 0], [x + 110, 0]], role: "ink", strokeWidth: 2.5, arrowEnd: true, step: s });
        if (c.conditions) out.texts.push(text("x-rxn-cond", c.conditions, x + 60, -30, { align: "center", fontSize: 14, tone: "muted", step: s }));
        x += 130;
      } else {
        out.texts.push(text(`x-plus${i}`, "+", x + 18, -18, { align: "center", fontSize: 28, tone: "body", step: s }));
        x += 46;
      }
    }
    if (isReaction && (m.coefficient ?? 1) > 1) {
      out.texts.push(text(`x-coef${i}`, String(m.coefficient), x + 10, -18, { align: "center", fontSize: 28, tone: "accent", step: s }));
      x += 34;
    }
    const dx = x - bb.x0, dy = -(bb.y0 + bb.y1) / 2;
    for (const p of scratch.paths) out.paths.push({ ...p, points: p.points.map(([px, py]) => [px + dx, py + dy] as Pt) });
    for (const t of scratch.texts) out.texts.push({ ...t, x: t.x + dx, y: t.y + dy });
    const width = bb.x1 - bb.x0;
    const parsed = parseSmiles(m.smiles!)!;
    const caption = isReaction
      ? `${m.name}\n${subscript(m.formula!)}`
      : `${m.name} · ${subscript(m.formula!)}\nM = ${parsed.weight.toFixed(2)} g/mol`;
    out.texts.push(text(`x-mcap${i}`, caption, x + width / 2, (bb.y1 - bb.y0) / 2 + 22, { align: "center", fontSize: 15, tone: "muted", step: s, w: Math.max(140, width + 40) }));
    parts.push(`${(m.coefficient ?? 1) > 1 ? `${m.coefficient} ` : ""}${subscript(m.formula!)}`);
    x += width + 40;
  });
  if (isReaction) {
    const reactantCount = c.molecules.filter((m) => m.role === "reactant").length;
    const equation = `${parts.slice(0, reactantCount).join(" + ")} → ${parts.slice(reactantCount).join(" + ")}`;
    const bottom = Math.max(...out.texts.map((t) => t.y + t.h)) + 24;
    out.texts.push(text("x-equation", equation, (x - 40) / 2, bottom, { align: "center", fontSize: 22, tone: "body", step: maxStep, w: 900 }));
  }
  return out;
}
