// ─────────────────────────────────────────────────────────
// Labelled diagrams: a starter set of code-drawn schematics
// (cells, heart, eye, flower, Earth's layers, neuron, leaf, digestive
// and respiratory systems, tooth, DNA) with NAMED parts.
//
// The model picks a template and which parts to label; it never
// positions a label.  Each part has a fixed anchor point, so a
// callout for "nucleus" always points at the nucleus.  These are
// simplified textbook schematics, not anatomical illustrations —
// the tutor says so when it uses one.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec, Role } from "./spec.js";
import { emptyBody, type Body, type PlacedPath, type Pt } from "./layout.js";
import { measureBlock } from "./textMetrics.js";
import { clampStep, dot, text } from "./layoutQuant.js";
import { registeredSketch } from "../sketch/store.js";

export interface TemplatePart {
  id: string;
  name: string;
  anchor: Pt;
  detail?: string;
  /** Where the callout goes (default: left or right, by the anchor's position). Wide drawings use top/bottom rows. */
  side?: "left" | "right" | "top" | "bottom";
}
export interface Template { id: string; title: string; paths: Array<Omit<PlacedPath, "step">>; parts: TemplatePart[] }

// ── Shape helpers ──────────────────────────────────────

function ellipse(cx: number, cy: number, rx: number, ry: number, rotDeg = 0, wobble = 0, seg = 48): Pt[] {
  const r = (rotDeg * Math.PI) / 180;
  const pts: Pt[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const k = 1 + wobble * Math.sin(3 * t) + wobble * 0.6 * Math.cos(5 * t);
    const x = rx * k * Math.cos(t), y = ry * k * Math.sin(t);
    pts.push([cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]);
  }
  pts[pts.length - 1] = pts[0];
  return pts;
}
function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, seg = 24): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = ((fromDeg + ((toDeg - fromDeg) * i) / seg) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}
const shape = (points: Pt[], role: Role | "ink", fill?: Role, extra: Partial<PlacedPath> = {}): Omit<PlacedPath, "step"> =>
  ({ id: "", points, closed: Boolean(fill), smooth: true, role, ...(fill ? { fill } : {}), strokeWidth: 2, ...extra });
const line = (points: Pt[], role: Role | "ink", extra: Partial<PlacedPath> = {}): Omit<PlacedPath, "step"> =>
  ({ id: "", points, smooth: points.length > 2, role, strokeWidth: 2, ...extra });

function mitochondrion(cx: number, cy: number, rot: number): Array<Omit<PlacedPath, "step">> {
  const r = (rot * Math.PI) / 180;
  const T = ([x, y]: Pt): Pt => [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
  const cristae: Pt[] = [];
  for (let i = 0; i <= 8; i++) cristae.push(T([-28 + i * 7, i % 2 ? 9 : -9]));
  return [shape(ellipse(cx, cy, 36, 17, rot), "danger", "danger"), line(cristae, "danger", { smooth: false, strokeWidth: 1.5 })];
}

// ── Templates ──────────────────────────────────────────

function animalCell(): Template {
  const ribosomes: Pt[] = [[150, 120], [330, 110], [120, 210], [380, 230], [200, 330], [300, 320], [160, 270], [350, 160]];
  const golgi = [0, 1, 2, 3].map((k) => line(arc(370, 300, 30 + k * 9, 200, 300, 12), "secondary", { strokeWidth: 3 }));
  const er = [0, 1, 2].map((k) => line(arc(240, 200, 74 + k * 12, -70, 40, 16).map(([x, y], i) => [x, y + (i % 2 ? 3 : -3)] as Pt), "accent", { strokeWidth: 2 }));
  return {
    id: "animal_cell", title: "Animal cell",
    paths: [
      shape(ellipse(250, 210, 215, 165, 0, 0.03), "warning", "warning", { strokeWidth: 3 }),
      ...er,
      shape(ellipse(240, 200, 58, 52), "secondary", "secondary", { strokeWidth: 2.5 }),
      shape(ellipse(250, 190, 17, 15), "secondary", "secondary", { strokeWidth: 2, fill: "primary" }),
      ...mitochondrion(120, 160, -25), ...mitochondrion(250, 330, 10),
      ...golgi,
      shape(ellipse(110, 280, 13, 13), "danger", "danger"),
      ...ribosomes.map((p) => shape(ellipse(p[0], p[1], 3.5, 3.5, 0, 0, 10), "ink", "muted")),
    ],
    parts: [
      { id: "cell_membrane", name: "Cell membrane", anchor: [60, 130] },
      { id: "cytoplasm", name: "Cytoplasm", anchor: [190, 90] },
      { id: "nucleus", name: "Nucleus", anchor: [215, 225] },
      { id: "nucleolus", name: "Nucleolus", anchor: [250, 190] },
      { id: "mitochondrion", name: "Mitochondrion", anchor: [120, 160] },
      { id: "ribosome", name: "Ribosome", anchor: [330, 110] },
      { id: "rough_er", name: "Rough endoplasmic reticulum", anchor: [320, 200] },
      { id: "golgi", name: "Golgi apparatus", anchor: [345, 285] },
      { id: "lysosome", name: "Lysosome", anchor: [110, 280] },
    ],
  };
}

function plantCell(): Template {
  const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const chloroplast = (cx: number, cy: number, rot: number) => {
    const r = (rot * Math.PI) / 180;
    const grana = [-16, 0, 16].map((dx) => {
      const p: Pt = [cx + dx * Math.cos(r), cy + dx * Math.sin(r)];
      return line([[p[0], p[1] - 6], [p[0], p[1] + 6]], "success", { strokeWidth: 3, smooth: false });
    });
    return [shape(ellipse(cx, cy, 32, 15, rot), "success", "success"), ...grana];
  };
  return {
    id: "plant_cell", title: "Plant cell",
    paths: [
      shape(rect(20, 20, 480, 380), "success", "success", { strokeWidth: 5, smooth: false }),
      shape(rect(32, 32, 468, 368), "warning", "warning", { strokeWidth: 2, smooth: false }),
      shape(ellipse(270, 215, 150, 105, 0, 0.02), "primary", "primary", { strokeWidth: 2.5 }),
      shape(ellipse(80, 90, 34, 30), "secondary", "secondary", { strokeWidth: 2.5 }),
      shape(ellipse(80, 90, 10, 9), "secondary", "primary"),
      ...chloroplast(90, 230, 70), ...chloroplast(420, 90, 10), ...chloroplast(260, 345, 0), ...chloroplast(440, 300, 80),
      ...mitochondrion(160, 60, 0),
    ],
    parts: [
      { id: "cell_wall", name: "Cell wall", anchor: [20, 300] },
      { id: "cell_membrane", name: "Cell membrane", anchor: [32, 340] },
      { id: "vacuole", name: "Vacuole", anchor: [270, 215] },
      { id: "nucleus", name: "Nucleus", anchor: [80, 90] },
      { id: "chloroplast", name: "Chloroplast", anchor: [420, 90] },
      { id: "mitochondrion", name: "Mitochondrion", anchor: [160, 60] },
      { id: "cytoplasm", name: "Cytoplasm", anchor: [400, 350] },
    ],
  };
}

function heart(): Template {
  // Front view: the patient's right side is on the viewer's LEFT. Blue = deoxygenated, red = oxygenated.
  const aorta: Pt[] = [[285, 215], [285, 70], ...arc(345, 70, 60, 180, 360, 20), [405, 140], [375, 140], ...arc(345, 70, 30, 360, 180, 14), [315, 215], [285, 215]];
  const pulmonaryArtery: Pt[] = [[248, 215], [248, 100], [150, 100], [150, 78], [262, 78], [345, 90], [345, 110], [272, 104], [272, 215], [248, 215]];
  return {
    id: "heart", title: "Human heart (schematic)",
    paths: [
      // Vessels (drawn first, so the chambers sit in front).
      shape([[112, 170], [142, 170], [142, 420], [112, 420], [112, 170]], "primary", "primary", { smooth: false }), // inferior vena cava
      shape([[160, 10], [195, 10], [195, 120], [160, 120], [160, 10]], "primary", "primary", { smooth: false }), // superior vena cava
      shape(aorta, "danger", "danger", { smooth: false }),
      shape(pulmonaryArtery, "primary", "primary", { smooth: false }),
      shape([[372, 120], [445, 110], [445, 135], [374, 145], [372, 120]], "danger", "danger", { smooth: false }), // pulmonary veins
      // Chambers.
      shape(ellipse(185, 160, 60, 50), "primary", "primary", { strokeWidth: 2.5 }), // right atrium
      shape(ellipse(330, 160, 55, 45), "danger", "danger", { strokeWidth: 2.5 }), // left atrium
      shape([[150, 220], [255, 215], [255, 400], [150, 290], [150, 220]], "primary", "primary", { strokeWidth: 2.5 }), // right ventricle
      shape([[262, 215], [390, 220], [380, 320], [262, 410], [262, 215]], "danger", "danger", { strokeWidth: 4 }), // left ventricle (thicker wall)
      line([[258, 205], [258, 405]], "ink", { strokeWidth: 4 }), // septum
      // Valves.
      line([[160, 212], [185, 222], [210, 212]], "ink", { strokeWidth: 3 }),
      line([[300, 210], [325, 222], [350, 210]], "ink", { strokeWidth: 3 }),
    ],
    parts: [
      { id: "right_atrium", name: "Right atrium", anchor: [180, 160] },
      { id: "left_atrium", name: "Left atrium", anchor: [340, 165] },
      { id: "right_ventricle", name: "Right ventricle", anchor: [195, 275] },
      { id: "left_ventricle", name: "Left ventricle", anchor: [320, 290] },
      { id: "septum", name: "Septum", anchor: [258, 340] },
      { id: "aorta", name: "Aorta", anchor: [345, 14] },
      { id: "pulmonary_artery", name: "Pulmonary artery", anchor: [180, 89] },
      { id: "pulmonary_veins", name: "Pulmonary veins", anchor: [432, 123] },
      { id: "superior_vena_cava", name: "Superior vena cava", anchor: [178, 35] },
      { id: "inferior_vena_cava", name: "Inferior vena cava", anchor: [127, 395] },
      { id: "tricuspid_valve", name: "Tricuspid valve", anchor: [185, 220] },
      { id: "mitral_valve", name: "Mitral (bicuspid) valve", anchor: [325, 220] },
    ],
  };
}

function eye(): Template {
  // Horizontal section, light enters from the left.
  return {
    id: "eye", title: "Human eye (schematic section)",
    paths: [
      shape(ellipse(270, 200, 150, 145), "muted", "muted", { strokeWidth: 3 }), // sclera
      line(arc(270, 200, 140, -120, 120, 30), "danger", { strokeWidth: 4 }), // retina (back of the eye)
      line(arc(160, 200, 70, 130, 230, 16), "primary", { strokeWidth: 3 }), // cornea bulge
      line([[128, 140], [128, 178]], "secondary", { strokeWidth: 6, smooth: false }), // iris (top)
      line([[128, 222], [128, 260]], "secondary", { strokeWidth: 6, smooth: false }), // iris (bottom)
      shape(ellipse(150, 200, 16, 42), "accent", "accent", { strokeWidth: 2.5 }), // lens
      line([[150, 158], [140, 80]], "ink", { strokeWidth: 1.5, smooth: false }), // suspensory ligaments
      line([[150, 242], [140, 320]], "ink", { strokeWidth: 1.5, smooth: false }),
      shape([[410, 215], [480, 205], [480, 250], [405, 245], [410, 215]], "warning", "warning", { smooth: false }), // optic nerve
      shape(ellipse(412, 195, 6, 6, 0, 0, 12), "danger", "danger"), // fovea
    ],
    parts: [
      { id: "cornea", name: "Cornea", anchor: [92, 200] },
      { id: "iris", name: "Iris", anchor: [128, 150] },
      { id: "pupil", name: "Pupil", anchor: [126, 196] },
      { id: "lens", name: "Lens", anchor: [150, 200] },
      { id: "suspensory_ligaments", name: "Suspensory ligaments", anchor: [145, 110] },
      { id: "aqueous_humour", name: "Aqueous humour", anchor: [112, 232] },
      { id: "vitreous_humour", name: "Vitreous humour", anchor: [320, 270] },
      { id: "retina", name: "Retina", anchor: [330, 78] },
      { id: "fovea", name: "Fovea", anchor: [412, 195] },
      { id: "optic_nerve", name: "Optic nerve", anchor: [465, 228] },
      { id: "sclera", name: "Sclera", anchor: [270, 345] },
    ],
  };
}

function flower(): Template {
  return {
    id: "flower", title: "Flower (longitudinal section)",
    paths: [
      line([[250, 300], [250, 420]], "success", { strokeWidth: 6, smooth: false }), // stem
      shape(ellipse(250, 300, 40, 16), "success", "success"), // receptacle
      shape([[215, 300], [150, 290], [165, 270], [220, 288], [215, 300]], "success", "success"), // sepals
      shape([[285, 300], [350, 290], [335, 270], [280, 288], [285, 300]], "success", "success"),
      shape([[220, 290], [110, 140], [150, 110], [235, 270], [220, 290]], "danger", "danger"), // petals
      shape([[280, 290], [390, 140], [350, 110], [265, 270], [280, 290]], "danger", "danger"),
      shape(ellipse(250, 255, 26, 30), "warning", "warning"), // ovary
      ...[0, 1, 2].map((k) => shape(ellipse(250, 240 + k * 15, 5, 5, 0, 0, 12), "ink", "muted")), // ovules
      line([[250, 225], [250, 130]], "warning", { strokeWidth: 5, smooth: false }), // style
      shape(ellipse(250, 122, 16, 9), "warning", "warning"), // stigma
      line([[232, 280], [195, 160]], "secondary", { strokeWidth: 2.5, smooth: false }), // filaments
      line([[268, 280], [305, 160]], "secondary", { strokeWidth: 2.5, smooth: false }),
      shape(ellipse(192, 150, 10, 16, -15), "secondary", "secondary"), // anthers
      shape(ellipse(308, 150, 10, 16, 15), "secondary", "secondary"),
    ],
    parts: [
      { id: "petal", name: "Petal", anchor: [140, 150] },
      { id: "sepal", name: "Sepal", anchor: [340, 285] },
      { id: "stigma", name: "Stigma", anchor: [250, 122] },
      { id: "style", name: "Style", anchor: [250, 180] },
      { id: "ovary", name: "Ovary", anchor: [265, 270] },
      { id: "ovule", name: "Ovule", anchor: [250, 255] },
      { id: "anther", name: "Anther", anchor: [192, 150] },
      { id: "filament", name: "Filament", anchor: [215, 225] },
      { id: "receptacle", name: "Receptacle", anchor: [250, 305] },
      { id: "stem", name: "Stem (stalk)", anchor: [250, 390] },
    ],
  };
}

function earthLayers(): Template {
  // Radii to scale (6371 km → 200 px) except the crust, which is exaggerated so it is visible.
  const R = 200, s = R / 6371;
  const r660 = (6371 - 660) * s, rCore = 3480 * s, rInner = 1220 * s;
  const cx = 230, cy = 230;
  const disc = (r: number, role: Role) => shape(ellipse(cx, cy, r, r, 0, 0, 72), role, role, { strokeWidth: 2 });
  return {
    id: "earth_layers", title: "Layers of the Earth",
    paths: [disc(R, "success"), disc(R - 8, "warning"), disc(r660, "danger"), disc(rCore, "secondary"), disc(rInner, "primary")],
    parts: [
      { id: "crust", name: "Crust", anchor: [cx + 0.7 * (R - 3), cy - 0.71 * (R - 3)], detail: "5–70 km thick (thickness exaggerated)" },
      { id: "upper_mantle", name: "Upper mantle", anchor: [cx - 0.7 * ((R - 8 + r660) / 2), cy - 0.71 * ((R - 8 + r660) / 2)], detail: "to ~660 km deep" },
      { id: "lower_mantle", name: "Lower mantle", anchor: [cx + 0.7 * ((r660 + rCore) / 2), cy + 0.71 * ((r660 + rCore) / 2)], detail: "660–2,890 km deep" },
      { id: "outer_core", name: "Outer core (liquid)", anchor: [cx - 0.7 * ((rCore + rInner) / 2), cy + 0.71 * ((rCore + rInner) / 2)], detail: "2,890–5,150 km deep" },
      { id: "inner_core", name: "Inner core (solid)", anchor: [cx, cy], detail: "radius ~1,220 km" },
    ],
  };
}


function neuron(): Template {
  // A motor neuron: dendrites → cell body → myelinated axon → axon terminals.
  const dendrites: Array<Omit<PlacedPath, "step">> = [];
  const branch = (from: Pt, angleDeg: number, len: number, depth: number) => {
    const a = (angleDeg * Math.PI) / 180;
    const to: Pt = [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
    dendrites.push(line([from, to], "secondary", { strokeWidth: depth === 0 ? 3 : 2, smooth: false }));
    if (depth < 2) for (const d of [-28, 26]) branch(to, angleDeg + d, len * 0.6, depth + 1);
  };
  for (const ang of [180, 140, 220, 100, 260]) branch([110 + Math.cos((ang * Math.PI) / 180) * 40, 150 + Math.sin((ang * Math.PI) / 180) * 38], ang, 42, 0);
  const myelin = [205, 265, 325, 385].map((x) => shape(ellipse(x, 150, 26, 11), "warning", "warning", { strokeWidth: 2 }));
  const terminals: Array<Omit<PlacedPath, "step">> = [];
  for (const dy of [-34, -12, 12, 34]) {
    terminals.push(line([[425, 150], [452, 150 + dy * 0.6], [478, 150 + dy]], "secondary", { strokeWidth: 2 }));
    terminals.push(shape(ellipse(483, 150 + dy, 6, 6, 0, 0, 12), "secondary", "secondary"));
  }
  return {
    id: "neuron", title: "Neuron (motor neuron)",
    paths: [
      ...dendrites,
      line([[150, 150], [425, 150]], "secondary", { strokeWidth: 3, smooth: false }), // axon
      shape(ellipse(110, 150, 46, 42, 0, 0.06), "secondary", "secondary", { strokeWidth: 2.5 }), // cell body
      shape([[148, 136], [178, 146], [178, 154], [148, 164], [148, 136]], "secondary", "secondary", { smooth: false }), // axon hillock
      shape(ellipse(108, 150, 17, 15), "primary", "primary"), // nucleus
      ...myelin,
      ...terminals,
    ],
    parts: [
      { id: "dendrites", name: "Dendrites", anchor: [50, 108], side: "left" },
      { id: "cell_body", name: "Cell body (soma)", anchor: [128, 178], side: "bottom" },
      { id: "nucleus", name: "Nucleus", anchor: [108, 150], side: "top" },
      { id: "axon_hillock", name: "Axon hillock", anchor: [166, 150], side: "bottom" },
      { id: "axon", name: "Axon", anchor: [295, 150], side: "bottom" },
      { id: "myelin_sheath", name: "Myelin sheath", anchor: [265, 141], side: "top" },
      { id: "node_of_ranvier", name: "Node of Ranvier", anchor: [235, 150], side: "top" },
      { id: "axon_terminals", name: "Axon terminals", anchor: [483, 116], side: "right" },
    ],
  };
}

function leafSection(): Template {
  const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const paths: Array<Omit<PlacedPath, "step">> = [];
  paths.push(shape(rect(20, 24, 500, 32), "warning", "warning", { smooth: false, strokeWidth: 1.5 })); // cuticle
  for (let x = 20; x < 500; x += 40) paths.push(shape(rect(x, 32, x + 40, 58), "accent", "accent", { smooth: false, strokeWidth: 1.5 })); // upper epidermis
  for (let x = 22; x < 496; x += 34) {
    paths.push(shape(rect(x, 62, x + 30, 150), "success", "success", { strokeWidth: 1.5 })); // palisade cells
    for (const y of [80, 105, 130]) paths.push(shape(ellipse(x + 15, y, 5, 4, 0, 0, 10), "success", "success", { strokeWidth: 1 }));
  }
  const spongy: Pt[] = [[45, 175], [100, 165], [150, 205], [70, 225], [130, 245], [360, 170], [420, 200], [470, 172], [395, 240], [455, 238], [195, 238], [320, 235]];
  for (const [x, y] of spongy) paths.push(shape(ellipse(x, y, 22, 16, (x * 7) % 40, 0.08), "success", "success", { strokeWidth: 1.5, opacity: 70 }));
  paths.push(shape(ellipse(258, 196, 40, 36), "secondary", "secondary", { strokeWidth: 2 })); // vascular bundle
  paths.push(line([[220, 196], [296, 196]], "secondary", { strokeWidth: 1.5, smooth: false }));
  for (let x = 20; x < 500; x += 40) {
    if (x === 300) continue; // the stoma sits in this gap
    paths.push(shape(rect(x, 262, x + 40, 286), "accent", "accent", { smooth: false, strokeWidth: 1.5 })); // lower epidermis
  }
  paths.push(shape(ellipse(311, 274, 9, 13), "success", "success")); // guard cells
  paths.push(shape(ellipse(329, 274, 9, 13), "success", "success"));
  return {
    id: "leaf_section", title: "Leaf cross-section",
    paths,
    parts: [
      { id: "cuticle", name: "Waxy cuticle", anchor: [470, 28] },
      { id: "upper_epidermis", name: "Upper epidermis", anchor: [40, 45] },
      { id: "palisade_mesophyll", name: "Palisade mesophyll", anchor: [37, 105] },
      { id: "spongy_mesophyll", name: "Spongy mesophyll", anchor: [420, 200] },
      { id: "air_space", name: "Air space", anchor: [285, 160] },
      { id: "xylem", name: "Xylem", anchor: [258, 180] },
      { id: "phloem", name: "Phloem", anchor: [258, 212] },
      { id: "lower_epidermis", name: "Lower epidermis", anchor: [60, 274] },
      { id: "stoma", name: "Stoma", anchor: [320, 274] },
      { id: "guard_cells", name: "Guard cells", anchor: [329, 284] },
    ],
  };
}

function digestiveSystem(): Template {
  // Front view: the patient's right is on the viewer's LEFT (liver on the left of the picture).
  const coils: Pt[] = [];
  for (let row = 0; row < 5; row++) {
    const y = 300 + row * 22;
    const xs = row % 2 ? [255, 135] : [135, 255];
    coils.push([xs[0], y], [xs[1], y]);
  }
  return {
    id: "digestive_system", title: "Human digestive system (schematic)",
    paths: [
      line([[182, 20], [190, 80], [200, 150], [215, 178]], "warning", { strokeWidth: 12 }), // oesophagus
      shape([[60, 170], [215, 160], [205, 205], [150, 240], [75, 235], [55, 205], [60, 170]], "danger", "danger", { strokeWidth: 2.5 }), // liver
      shape(ellipse(150, 248, 13, 18, 20), "success", "success"), // gall bladder
      shape([[215, 172], [265, 168], [300, 195], [290, 245], [245, 262], [215, 245], [235, 225], [255, 205], [215, 190], [215, 172]], "warning", "warning", { strokeWidth: 2.5 }), // stomach
      shape(ellipse(222, 272, 52, 10, -8), "accent", "accent"), // pancreas
      line([[110, 410], [105, 285], [275, 282], [280, 415], [205, 425], [200, 452]], "secondary", { strokeWidth: 14 }), // large intestine → rectum
      line([[106, 412], [98, 436]], "secondary", { strokeWidth: 6 }), // appendix
      line(coils, "primary", { strokeWidth: 9 }), // small intestine
      shape(ellipse(182, 16, 16, 7), "danger", "danger"), // mouth
      shape(ellipse(200, 462, 7, 5), "secondary", "secondary"), // anus
    ],
    parts: [
      { id: "mouth", name: "Mouth", anchor: [182, 16] },
      { id: "oesophagus", name: "Oesophagus (gullet)", anchor: [191, 90] },
      { id: "liver", name: "Liver", anchor: [100, 200] },
      { id: "gall_bladder", name: "Gall bladder", anchor: [150, 252] },
      { id: "stomach", name: "Stomach", anchor: [268, 205] },
      { id: "pancreas", name: "Pancreas", anchor: [255, 270] },
      { id: "small_intestine", name: "Small intestine", anchor: [195, 344] },
      { id: "large_intestine", name: "Large intestine (colon)", anchor: [278, 350] },
      { id: "appendix", name: "Appendix", anchor: [99, 434] },
      { id: "rectum", name: "Rectum", anchor: [203, 438] },
      { id: "anus", name: "Anus", anchor: [200, 462] },
    ],
  };
}

function tooth(): Template {
  // Vertical section through a molar.
  const outer: Pt[] = [[70, 170], [65, 90], [80, 45], [110, 35], [130, 55], [150, 40], [170, 55], [190, 35], [220, 45], [235, 90], [230, 170], [222, 250], [210, 370], [185, 380], [170, 260], [150, 240], [130, 260], [115, 380], [90, 370], [78, 250], [70, 170]];
  const enamel: Pt[] = [[70, 170], [65, 90], [80, 45], [110, 35], [130, 55], [150, 40], [170, 55], [190, 35], [220, 45], [235, 90], [230, 170], [215, 165], [218, 95], [205, 62], [188, 54], [170, 72], [150, 60], [130, 72], [112, 54], [95, 62], [82, 95], [85, 165], [70, 170]];
  const pulp: Pt[] = [[110, 150], [115, 100], [150, 92], [185, 100], [190, 150], [184, 205], [194, 350], [189, 362], [176, 250], [160, 222], [140, 222], [124, 250], [111, 362], [106, 350], [116, 205], [110, 150]];
  return {
    id: "tooth", title: "Structure of a tooth (molar)",
    paths: [
      shape([[20, 228], [280, 228], [280, 410], [20, 410], [20, 228]], "muted", "muted", { smooth: false, strokeWidth: 1.5 }), // jaw bone
      shape([[20, 150], [72, 172], [78, 232], [20, 232], [20, 150]], "danger", "danger", { opacity: 55 }), // gum (left)
      shape([[280, 150], [228, 172], [222, 232], [280, 232], [280, 150]], "danger", "danger", { opacity: 55 }), // gum (right)
      shape(outer, "warning", "warning", { strokeWidth: 2.5 }), // dentine
      shape(enamel, "muted", "muted", { strokeWidth: 2.5 }), // enamel
      shape(pulp, "danger", "danger", { strokeWidth: 2 }), // pulp
      line([[150, 130], [150, 215], [118, 300], [112, 405]], "danger", { strokeWidth: 2 }), // nerve & blood vessels
      line([[156, 130], [156, 215], [186, 300], [190, 405]], "primary", { strokeWidth: 2 }),
      line([[80, 250], [92, 368]], "secondary", { strokeWidth: 3, smooth: false }), // cementum
      line([[220, 250], [208, 368]], "secondary", { strokeWidth: 3, smooth: false }),
    ],
    parts: [
      { id: "crown", name: "Crown", anchor: [150, 50] },
      { id: "enamel", name: "Enamel", anchor: [96, 52] },
      { id: "dentine", name: "Dentine", anchor: [215, 205] },
      { id: "pulp", name: "Pulp cavity", anchor: [150, 160] },
      { id: "gum", name: "Gum (gingiva)", anchor: [40, 200] },
      { id: "root", name: "Root", anchor: [200, 320] },
      { id: "cementum", name: "Cementum", anchor: [86, 310] },
      { id: "jaw_bone", name: "Jaw bone", anchor: [255, 380] },
      { id: "nerves_blood_vessels", name: "Nerves and blood vessels", anchor: [112, 400] },
    ],
  };
}

function dna(): Template {
  // Double helix seen from the side: two sugar-phosphate backbones, base pairs as rungs (A–T, G–C).
  const strand = (phase: number): Pt[] => {
    const pts: Pt[] = [];
    for (let x = 20; x <= 500; x += 8) pts.push([x, 120 + 72 * Math.sin(((x - 20) / 240) * 2 * Math.PI + phase)]);
    return pts;
  };
  const BASE_ROLE: Record<string, Role> = { A: "danger", T: "warning", G: "success", C: "primary" };
  const pairs: Array<[string, string]> = [["A", "T"], ["G", "C"], ["T", "A"], ["C", "G"]];
  const rungs: Array<Omit<PlacedPath, "step">> = [];
  /** Where each base letter was drawn (the middle of its half-rung), for the callout anchors. */
  const seen: Record<string, Pt[]> = { A: [], T: [], G: [], C: [] };
  const mids: Pt[] = [];
  let k = 0;
  for (let x = 32; x <= 488; x += 24) {
    const s = Math.sin(((x - 20) / 240) * 2 * Math.PI);
    if (Math.abs(s) < 0.3) continue; // too foreshortened where the strands cross
    const y1 = 120 + 72 * s, y2 = 120 - 72 * s, mid = 120;
    const [a, b] = pairs[k++ % pairs.length];
    rungs.push(line([[x, y1], [x, mid - Math.sign(s) * 3]], BASE_ROLE[a], { strokeWidth: 6, smooth: false }));
    rungs.push(line([[x, mid + Math.sign(s) * 3], [x, y2]], BASE_ROLE[b], { strokeWidth: 6, smooth: false }));
    seen[a].push([x, (y1 + mid) / 2]);
    seen[b].push([x, (y2 + mid) / 2]);
    mids.push([x, mid]);
  }
  // Spread the anchors along the helix: pick each base's occurrence nearest a different target x.
  const near = (pts: Pt[], x: number): Pt => pts.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best));
  return {
    id: "dna", title: "DNA double helix (schematic)",
    paths: [...rungs, line(strand(0), "secondary", { strokeWidth: 5 }), line(strand(Math.PI), "accent", { strokeWidth: 5 })],
    parts: [
      { id: "sugar_phosphate_backbone", name: "Sugar–phosphate backbone", anchor: [80, 48], side: "left" },
      { id: "adenine", name: "Adenine (A)", detail: "pairs with thymine", anchor: near(seen.A, 140), side: "top" },
      { id: "guanine", name: "Guanine (G)", detail: "pairs with cytosine", anchor: near(seen.G, 300), side: "top" },
      { id: "base_pair", name: "Base pair", anchor: near(mids, 420), side: "top" },
      { id: "thymine", name: "Thymine (T)", detail: "pairs with adenine", anchor: near(seen.T, 140), side: "bottom" },
      { id: "cytosine", name: "Cytosine (C)", detail: "pairs with guanine", anchor: near(seen.C, 300), side: "bottom" },
      { id: "hydrogen_bonds", name: "Hydrogen bonds", detail: "hold the bases together", anchor: near(mids, 400), side: "bottom" },
    ],
  };
}

function respiratorySystem(): Template {
  // Front view: the patient's right lung (three lobes) is on the viewer's LEFT.
  const bronchioles: Array<Omit<PlacedPath, "step">> = [];
  const tree = (from: Pt, angleDeg: number, len: number, depth: number) => {
    const a = (angleDeg * Math.PI) / 180;
    const to: Pt = [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
    bronchioles.push(line([from, to], "danger", { strokeWidth: 3 - depth, smooth: false }));
    if (depth < 2) for (const d of [-30, 30]) tree(to, angleDeg + d, len * 0.68, depth + 1);
  };
  tree([150, 215], 120, 50, 0);
  tree([150, 215], 165, 40, 0);
  tree([270, 215], 60, 50, 0);
  tree([270, 215], 15, 40, 0);
  const rings = [60, 85, 110, 135, 160].map((y) => line([[198, y], [222, y]], "muted", { strokeWidth: 2, smooth: false }));
  const alveoli = [[78, 330], [90, 320], [95, 336], [84, 344], [72, 342]].map(([x, y]) => shape(ellipse(x, y, 7, 7, 0, 0, 12), "danger", "danger"));
  return {
    id: "respiratory_system", title: "Human respiratory system (schematic)",
    paths: [
      shape([[150, 120], [192, 150], [200, 210], [185, 300], [150, 360], [60, 370], [42, 300], [60, 190], [150, 120]], "danger", "danger", { opacity: 45, strokeWidth: 2.5 }), // right lung
      shape([[270, 120], [228, 150], [222, 205], [248, 240], [232, 290], [262, 360], [360, 370], [378, 300], [360, 190], [270, 120]], "danger", "danger", { opacity: 45, strokeWidth: 2.5 }), // left lung (cardiac notch)
      shape([[198, 18], [222, 18], [222, 175], [198, 175], [198, 18]], "muted", "muted", { smooth: false }), // trachea
      ...rings,
      shape(ellipse(210, 22, 20, 10), "accent", "accent"), // larynx
      line([[210, 172], [150, 215]], "muted", { strokeWidth: 10, smooth: false }), // right bronchus
      line([[210, 172], [270, 215]], "muted", { strokeWidth: 10, smooth: false }), // left bronchus
      ...bronchioles,
      ...alveoli,
      line([[30, 400], [120, 372], [210, 382], [300, 372], [390, 400]], "warning", { strokeWidth: 4 }), // diaphragm
    ],
    parts: [
      { id: "larynx", name: "Larynx (voice box)", anchor: [210, 22] },
      { id: "trachea", name: "Trachea (windpipe)", anchor: [210, 100] },
      { id: "bronchus", name: "Bronchus", anchor: [240, 193] },
      { id: "bronchioles", name: "Bronchioles", anchor: [118, 262] },
      { id: "alveoli", name: "Alveoli (air sacs)", anchor: [84, 334] },
      { id: "right_lung", name: "Right lung", anchor: [70, 230] },
      { id: "left_lung", name: "Left lung", anchor: [345, 300] },
      { id: "diaphragm", name: "Diaphragm", anchor: [300, 372] },
    ],
  };
}

export const TEMPLATES: Record<string, () => Template> = {
  animal_cell: animalCell, plant_cell: plantCell, heart, eye, flower, earth_layers: earthLayers,
  neuron, leaf_section: leafSection, digestive_system: digestiveSystem, tooth, dna, respiratory_system: respiratorySystem,
};
const TEMPLATE_ALIASES: Record<string, string> = {
  cell: "animal_cell", animal: "animal_cell", human_cell: "animal_cell", plant: "plant_cell", human_heart: "heart", heart_diagram: "heart",
  human_eye: "eye", eye_section: "eye", flower_parts: "flower", parts_of_a_flower: "flower", earth: "earth_layers", earth_structure: "earth_layers",
  structure_of_the_earth: "earth_layers", layers_of_the_earth: "earth_layers",
  nerve_cell: "neuron", motor_neuron: "neuron", leaf: "leaf_section", leaf_cross_section: "leaf_section", leaf_structure: "leaf_section",
  digestive: "digestive_system", digestion: "digestive_system", alimentary_canal: "digestive_system", gut: "digestive_system",
  molar: "tooth", teeth: "tooth", tooth_structure: "tooth", double_helix: "dna", dna_structure: "dna", dna_double_helix: "dna",
  lungs: "respiratory_system", respiratory: "respiratory_system", breathing_system: "respiratory_system", lung: "respiratory_system",
};
export const resolveTemplate = (id: string) => (TEMPLATES[id] ? id : TEMPLATE_ALIASES[id]);

/** Compact catalogue for the designer prompt. */
export function templateCatalogue(): string {
  return Object.entries(TEMPLATES).map(([id, make]) => `${id}: ${make().parts.map((p) => p.id).join(", ")}`).join("\n");
}

// ── Validation / layout ────────────────────────────────

/** The drawing for a labelled spec: a built-in template, or a registered sketch (see src/sketch/). */
export function templateFor(l: NonNullable<DiagramSpec["labelled"]>): (Template & { credit?: string }) | null {
  const id = resolveTemplate(l.template);
  if (id) return TEMPLATES[id]();
  const s = registeredSketch(l.sketch);
  return s ? { id: s.slug, title: s.title, ...s.drawing, credit: s.source.credit } : null;
}

export function validateLabelled(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const l = spec.labelled;
  if (!l) { critical.push('kind "labelled_diagram" needs a "labelled" block'); return spec; }
  const builtIn = resolveTemplate(l.template);
  const t = templateFor(l);
  if (!t) {
    // No built-in schematic: the Sketcher finds a reference diagram or sketches one from the requested parts.
    if (!l.labels.length) {
      critical.push(`"${l.template}" is not a built-in schematic: list the parts to label in "labels" (snake_case "part" ids with standard textbook names, and "text") so it can be sketched`);
      return spec;
    }
    const seen = new Set<string>();
    const labels = l.labels
      .map((lb) => ({ ...lb, part: lb.part.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") }))
      .filter((lb) => lb.part && !seen.has(lb.part) && seen.add(lb.part));
    return { ...spec, labelled: { template: l.template.replace(/[^a-z0-9_]+/g, "_").slice(0, 40), labels } };
  }
  const id = builtIn ?? t.id;
  const known = new Map(t.parts.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const labels = l.labels.filter((lb) => {
    const pid = lb.part.toLowerCase().replace(/[\s-]+/g, "_");
    const ok = known.has(pid) && !seen.has(pid);
    if (!known.has(pid)) issues.push(`"${lb.part}" is not a part of the ${id} schematic (parts: ${[...known.keys()].join(", ")}) → dropped`);
    seen.add(pid);
    lb.part = pid;
    return ok;
  });
  return { ...spec, labelled: { template: id, ...(builtIn ? {} : { sketch: l.sketch }), labels } };
}

/** Label plus the part's detail line, unless the label already says it ("Nephron (filtering unit)"). */
const withDetail = (label: string, detail: string | undefined) =>
  detail && !label.toLowerCase().includes(detail.toLowerCase()) ? `${label}\n${detail}` : label;

function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function layoutLabelled(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const l = spec.labelled!;
  const t = templateFor(l);
  if (!t) throw new Error(`no drawing for "${l.template}" (sketch not prepared)`);
  t.paths.forEach((p, i) => body.paths.push({ ...p, id: `x-tp${i}`, step: 1 }));
  const chosen = l.labels.length
    ? l.labels.flatMap((lb) => { const part = t.parts.find((p) => p.id === lb.part); return part ? [{ part, text: lb.text, step: lb.step }] : []; })
    : t.parts.map((part, i) => ({ part, text: undefined, step: Math.min(maxStep, 1 + Math.floor((i * maxStep) / t.parts.length)) }));
  const xs = t.paths.flatMap((p) => p.points.map((q) => q[0])), ys = t.paths.flatMap((p) => p.points.map((q) => q[1]));
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const midX = (minX + maxX) / 2;

  const sideOf = (c: (typeof chosen)[number]) => c.part.side ?? (c.part.anchor[0] < midX ? "left" : "right");

  // Rows above / below (wide drawings): ordered by anchor x and pushed apart horizontally.
  for (const row of ["top", "bottom"] as const) {
    const items = chosen
      .filter((c) => sideOf(c) === row)
      .map((c) => {
        const label = c.text ?? c.part.name;
        const block = measureBlock(withDetail(label, c.part.detail), 15, 170);
        return { ...c, block, x: c.part.anchor[0] - block.width / 2 };
      })
      .sort((a, b) => a.part.anchor[0] - b.part.anchor[0]);
    for (let k = 1; k < items.length; k++) items[k].x = Math.max(items[k].x, items[k - 1].x + items[k - 1].block.width + 18);
    items.forEach((it) => {
      const s = clampStep(it.step, maxStep);
      const ty = row === "top" ? minY - 46 - it.block.height : maxY + 46;
      const attach: Pt = [it.x + it.block.width / 2, row === "top" ? ty + it.block.height + 4 : ty - 4];
      body.paths.push({ id: `x-lead_${it.part.id}`, points: [attach, it.part.anchor], role: "ink", strokeWidth: 1.5, step: s });
      body.paths.push(dot(`x-leaddot_${it.part.id}`, it.part.anchor[0], it.part.anchor[1], "ink" as Role, s, 3));
      body.texts.push(text(`x-lbl_${it.part.id}`, it.block.text, it.x + it.block.width / 2, ty, { fontSize: 15, tone: "body", step: s, w: 170, align: "center" }));
    });
  }

  // Callouts in two columns, ordered by anchor height so leader lines don't cross.
  for (const side of [-1, 1]) {
    const items = chosen
      .filter((c) => sideOf(c) === (side < 0 ? "left" : "right"))
      .map((c) => {
        const label = c.text ?? c.part.name;
        const full = withDetail(label, c.part.detail);
        const block = measureBlock(full, 15, 190);
        return { ...c, block, y: c.part.anchor[1] - block.height / 2 };
      })
      .sort((a, b) => a.part.anchor[1] - b.part.anchor[1]);
    const colX = side < 0 ? minX - 70 : maxX + 70;
    const stack = () => {
      items.forEach((it) => { it.y = it.part.anchor[1] - it.block.height / 2; });
      for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + items[k - 1].block.height + 12);
      const overflow = items.length ? items[items.length - 1].y + items[items.length - 1].block.height - (maxY + 20) : 0;
      if (overflow > 0) items.forEach((it) => { it.y -= Math.min(overflow, Math.max(0, it.y - (minY - 30))); });
      for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + items[k - 1].block.height + 12);
    };
    const attachOf = (it: (typeof items)[number]): Pt => [side < 0 ? colX + 6 : colX - 6, it.y + 10];
    // Labels are stacked in anchor order; any two leader lines that still cross swap slots.
    stack();
    for (let pass = 0; pass < 30; pass++) {
      let swapped = false;
      for (let a = 0; a < items.length && !swapped; a++) for (let b = a + 1; b < items.length && !swapped; b++) {
        if (segmentsCross(attachOf(items[a]), items[a].part.anchor, attachOf(items[b]), items[b].part.anchor)) {
          [items[a], items[b]] = [items[b], items[a]];
          const ya = items[a].y;
          items[a].y = items[b].y;
          items[b].y = ya;
          swapped = true;
        }
      }
      if (!swapped) break;
      // Re-stack in the new order without re-sorting.
      for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + items[k - 1].block.height + 12);
    }
    items.forEach((it) => {
      const s = clampStep(it.step, maxStep);
      const ty = it.y;
      const lx = side < 0 ? colX - it.block.width : colX;
      const attach: Pt = [side < 0 ? colX + 6 : colX - 6, ty + 10];
      body.paths.push({ id: `x-lead_${it.part.id}`, points: [attach, it.part.anchor], role: "ink", strokeWidth: 1.5, step: s });
      body.paths.push(dot(`x-leaddot_${it.part.id}`, it.part.anchor[0], it.part.anchor[1], "ink" as Role, s, 3));
      body.texts.push(text(`x-lbl_${it.part.id}`, it.block.text, lx, ty, { fontSize: 15, tone: "body", step: s, w: 190 }));
    });
  }
  // Where a sketch came from (licences such as CC BY require the credit).
  if (t.credit) {
    const bottom = Math.max(maxY, ...body.texts.map((x) => x.y + x.h));
    body.texts.push(text("x-credit", t.credit, (minX + maxX) / 2, bottom + 22, { fontSize: 12, tone: "muted", step: 1, w: Math.max(320, maxX - minX), align: "center" }));
  }
  return body;
}
