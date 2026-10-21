// ─────────────────────────────────────────────────────────
// DiagramSpec — the semantic contract between the Visual
// Planner (LLM) and the deterministic layout engine.
//
// The LLM describes WHAT to show (nodes, relationships,
// roles, teaching step); it never chooses coordinates,
// colors, or element IDs on the canvas.  Everything here is
// validated with zod and then semantically repaired by
// diagram/validate.ts before layout.
// ─────────────────────────────────────────────────────────

import { z } from "zod";

export const DIAGRAM_KINDS = [
  "flowchart",   // processes, algorithms, decisions
  "tree",        // hierarchies, BSTs, heaps, DOM, class hierarchies
  "graph",       // networks, dependency graphs, state machines
  "sequence",    // message exchanges over time (protocols, API calls)
  "array",       // arrays / strings with index + pointer annotations, multi-frame traces
  "linked_list",
  "stack",
  "queue",
  "layers",      // protocol stacks, architecture tiers, memory hierarchy
  "comparison",  // side-by-side columns (X vs Y)
  "mindmap",     // concept overviews
  "timeline",    // ordered stages / pipelines WITHOUT real dates (use scaled_timeline for dated history)
  "formula",     // math: equations + derivation steps (uses `formulas`)
  // ── Quantitative / spatial kinds: geometry is computed by code from data ──
  "number_line",      // integers, fractions, operations as jumps, inequalities (uses `numberLine`)
  "coordinate_plane", // function plots, points, intersections (uses `plot`)
  "geometry",         // shapes from coordinates, angles, circles (uses `geometry`)
  "chart",            // bar / line / pie / scatter (uses `chart`)
  "table",            // tables, matrices, truth tables, Punnett squares (uses `table`)
  "venn",             // 2–3 set Venn diagrams (uses `venn`)
  "cycle",            // circular processes: water/carbon/cell cycles (uses `nodes` in order)
  "scaled_timeline",  // dated events on a true time scale (uses `chronology`)
  // ── Science & geography kinds (Phase B) ──
  "vectors",          // forces, free-body diagrams, vector addition (uses `vectors`)
  "circuit",          // electric circuits from their series/parallel structure (uses `circuit`)
  "molecule",         // chemical structures from SMILES; reactions (uses `chemistry`)
  "atom",             // Bohr model of an element (uses `atom`)
  "labelled_diagram", // built-in schematic (cell, heart, eye…) with labelled parts (uses `labelled`)
  "map",              // countries, cities and routes on a real map (uses `map`)
] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const NODE_SHAPES = ["box", "rounded", "diamond", "circle", "pill"] as const;
export const ROLES = ["primary", "secondary", "accent", "success", "warning", "danger", "muted"] as const;
export type Role = (typeof ROLES)[number];

/** Lenient enum: unknown values fall back to undefined instead of failing the whole spec. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v),
    z.enum(values).optional().catch(undefined)
  );

const text = (max: number) =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().trim().max(max * 4))
    .transform((s) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s));

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), text(max).optional()).catch(undefined);

const step = z.preprocess(
  (v) => (typeof v === "string" ? parseInt(v, 10) : v),
  z.number().int().min(1).max(12).optional().catch(undefined)
);

const localId = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string().trim().min(1).max(64)
);

export const SpecNodeSchema = z.object({
  id: localId,
  label: text(80),
  detail: optionalText(120),
  shape: looseEnum(NODE_SHAPES),
  role: looseEnum(ROLES),
  /** tree / mindmap: parent node id. */
  parent: localId.optional().catch(undefined),
  /** binary trees: which side of the parent this child sits on. */
  side: looseEnum(["left", "right"] as const),
  /** comparison: column (group) id. */
  group: localId.optional().catch(undefined),
  step,
});

export const SpecEdgeSchema = z.object({
  from: localId,
  to: localId,
  label: optionalText(48),
  style: looseEnum(["solid", "dashed"] as const),
  directed: z.boolean().optional().catch(undefined),
  role: looseEnum(ROLES),
  step,
});

export const SpecGroupSchema = z.object({
  id: localId,
  label: text(60),
  role: looseEnum(ROLES),
});

export const SpecAnnotationSchema = z.object({
  target: localId,
  text: text(100),
  step,
});

/** One row of an array trace (e.g. one binary-search iteration). */
export const SpecFrameSchema = z.object({
  caption: optionalText(80),
  step,
  pointers: z
    .array(z.object({ label: text(16), index: z.coerce.number().int() }))
    .max(6)
    .optional()
    .catch(undefined),
  ranges: z
    .array(
      z.object({
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        role: looseEnum(ROLES),
      })
    )
    .max(8)
    .optional()
    .catch(undefined),
});

export const SpecFormulaSchema = z.object({
  latex: z.string().trim().min(1).max(400),
  caption: optionalText(100),
  step,
});

export const SpecCodeSchema = z.object({
  language: z.string().trim().min(1).max(20).catch("text"),
  code: z.string().min(1).max(2400),
  step,
});

// ── Data blocks for the quantitative kinds ─────────────
// Objects are validated strictly (so the model gets precise correction
// feedback); null / non-object values are treated as "absent".

const num = z.coerce.number().refine(Number.isFinite, "must be a finite number");
const flag = z.boolean().optional().catch(undefined);
const block = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null || typeof v !== "object" ? undefined : v), schema.optional());
const dateValue = z.union([z.number(), z.string().trim().min(1).max(40)]);

export const NumberLineSchema = z.object({
  min: num,
  max: num,
  step: z.coerce.number().positive().optional().catch(undefined),
  points: z.array(z.object({ value: num, label: optionalText(24), role: looseEnum(ROLES), step })).max(12).optional().catch(undefined),
  /** Operations as jumps: from → to. The +/- label is computed by code. */
  jumps: z.array(z.object({ from: num, to: num, label: optionalText(24), step })).max(10).optional().catch(undefined),
  /** Inequalities / ranges. Omit `from` or `to` for −∞ / +∞. */
  intervals: z
    .array(
      z.object({
        from: num.optional().catch(undefined),
        to: num.optional().catch(undefined),
        includeFrom: flag,
        includeTo: flag,
        label: optionalText(40),
        role: looseEnum(ROLES),
        step,
      })
    )
    .max(4)
    .optional()
    .catch(undefined),
});

export const PlotSchema = z.object({
  xMin: num.optional().catch(undefined),
  xMax: num.optional().catch(undefined),
  yMin: num.optional().catch(undefined),
  yMax: num.optional().catch(undefined),
  xLabel: optionalText(30),
  yLabel: optionalText(30),
  /** Expressions in x, e.g. "2x^2 - 3", "sin(x)". Parsed safely, never executed. */
  functions: z
    .array(z.object({ expr: z.string().trim().min(1).max(200), label: optionalText(40), role: looseEnum(ROLES), step }))
    .max(4)
    .default([]),
  points: z.array(z.object({ x: num, y: num, label: optionalText(30), role: looseEnum(ROLES), step })).max(16).optional().catch(undefined),
  segments: z
    .array(z.object({ from: z.tuple([num, num]), to: z.tuple([num, num]), label: optionalText(30), dashed: flag, role: looseEnum(ROLES), step }))
    .max(8)
    .optional()
    .catch(undefined),
  /** Mark (computed) intersections between the plotted functions. */
  showIntersections: flag,
});

export const GeometrySchema = z.object({
  points: z.array(z.object({ id: localId, x: num, y: num, label: optionalText(12), hidden: flag })).min(1).max(16),
  segments: z
    .array(z.object({ from: localId, to: localId, label: optionalText(24), showLength: flag, dashed: flag, role: looseEnum(ROLES), step }))
    .max(16)
    .optional()
    .catch(undefined),
  polygons: z
    .array(z.object({ vertices: z.array(localId).min(3).max(10), role: looseEnum(ROLES), label: optionalText(30), step }))
    .max(6)
    .optional()
    .catch(undefined),
  circles: z
    .array(
      z.object({
        center: localId,
        radius: z.coerce.number().positive().optional().catch(undefined),
        through: localId.optional().catch(undefined),
        role: looseEnum(ROLES),
        label: optionalText(30),
        step,
      })
    )
    .max(4)
    .optional()
    .catch(undefined),
  angles: z
    .array(z.object({ vertex: localId, from: localId, to: localId, label: optionalText(16), showMeasure: flag, step }))
    .max(8)
    .optional()
    .catch(undefined),
});

export const ChartSchema = z.object({
  type: looseEnum(["bar", "line", "pie", "scatter"] as const).transform((t) => t ?? "bar"),
  categories: z.array(text(24)).max(14).optional().catch(undefined),
  series: z.array(z.object({ name: text(30), values: z.array(num).max(14), role: looseEnum(ROLES) })).max(4).optional().catch(undefined),
  points: z.array(z.object({ x: num, y: num, label: optionalText(20) })).max(40).optional().catch(undefined),
  xLabel: optionalText(30),
  yLabel: optionalText(30),
  unit: optionalText(10),
});

export const TableSchema = z.object({
  columns: z.array(text(40)).min(1).max(8),
  rows: z.array(z.array(z.preprocess((v) => (v === null || v === undefined ? "" : v), text(60)))).min(1).max(16),
  highlight: z
    .array(z.object({ row: z.coerce.number().int(), col: z.coerce.number().int(), role: looseEnum(ROLES) }))
    .max(20)
    .optional()
    .catch(undefined),
  /** Style the first column as row headers. */
  rowHeaders: flag,
});

/**
 * A worked example solved step by step (numerical / reasoning problems). It comes from the
 * planner's explanation (so canvas and notes agree) and is drawn as a panel next to the diagram.
 */
export const WorkedStepSchema = z.object({
  title: text(60),
  /** The working, one line each, written as "expression = result" so the arithmetic can be checked. */
  lines: z.array(text(160)).max(8).default([]).catch([]),
  /** State after this step (distances, variables, queue…). */
  table: TableSchema.optional().catch(undefined),
  step,
});
export const WorkedSchema = z.object({
  title: optionalText(70),
  problem: text(400),
  /** The example's graph / network / tree, drawn above the steps (e.g. the weighted graph Dijkstra runs on). */
  figure: z
    .object({
      nodes: z.array(z.object({ id: localId, label: text(24) })).min(2).max(10),
      edges: z.array(z.object({ from: localId, to: localId, label: optionalText(16) })).max(20).default([]),
      directed: flag,
    })
    .optional()
    .catch(undefined),
  steps: z.array(WorkedStepSchema).min(1).max(12),
  answer: optionalText(200),
});
export type Worked = z.infer<typeof WorkedSchema>;

export const VennSchema = z.object({
  sets: z.array(z.object({ id: localId, label: text(30), role: looseEnum(ROLES) })).min(2).max(3),
  /** Items per region; `sets` lists every set the region is inside (e.g. ["a","b"] = intersection). */
  regions: z.array(z.object({ sets: z.array(localId).min(1).max(3), items: z.array(text(30)).max(6) })).max(7).default([]),
  universe: optionalText(30),
});

export const ChronologySchema = z.object({
  /** Dates: years (negative = BCE) or strings like "1914", "1914-07-28", "500 BCE". */
  events: z.array(z.object({ date: dateValue, label: text(50), role: looseEnum(ROLES), step })).max(14).default([]),
  periods: z
    .array(z.object({ from: dateValue, to: dateValue, label: text(40), role: looseEnum(ROLES), step }))
    .max(6)
    .optional()
    .catch(undefined),
});

// ── Phase B data blocks ──

export const VECTOR_DIRECTIONS = ["up", "down", "left", "right", "normal", "up_slope", "down_slope", "into_slope"] as const;

export const VectorsSchema = z.object({
  /** free_body: forces on one object · addition: head-to-tail with resultant · components: x/y split. */
  mode: looseEnum(["free_body", "addition", "components"] as const).transform((m) => m ?? "free_body"),
  object: optionalText(30),
  unit: optionalText(8),
  /** Slope angle in degrees for objects on an inclined plane. */
  incline: z.coerce.number().min(0).max(75).optional().catch(undefined),
  vectors: z
    .array(
      z.object({
        label: text(24),
        magnitude: num,
        /** Degrees counter-clockwise from "right" (0 = right, 90 = up). Ignored when `direction` is given. */
        angle: num.optional().catch(undefined),
        direction: looseEnum(VECTOR_DIRECTIONS),
        role: looseEnum(ROLES),
        step,
      })
    )
    .min(1)
    .max(8),
  showResultant: flag,
});

export const CIRCUIT_PARTS = ["resistor", "bulb", "switch", "capacitor", "ammeter", "voltmeter", "diode", "led", "fuse", "motor", "buzzer"] as const;
export type CircuitPartType = (typeof CIRCUIT_PARTS)[number];
export interface CircuitPart { type: CircuitPartType; label?: string; value?: number; open?: boolean; step?: number }
export interface CircuitParallel { parallel: CircuitItem[][] }
export type CircuitItem = CircuitPart | CircuitParallel;

const PART_ALIASES: Record<string, string> = { lamp: "bulb", light: "bulb", light_bulb: "bulb", resistance: "resistor", led_light: "led", bell: "buzzer" };

const CircuitPartSchema = z.object({
  type: z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return PART_ALIASES[k] ?? k;
  }, z.enum(CIRCUIT_PARTS)),
  label: optionalText(16),
  /** Resistance in ohms (resistor, bulb). */
  value: z.coerce.number().positive().optional().catch(undefined),
  /** Switches: true = open (no current). */
  open: flag,
  step,
});
const CircuitItemSchema: z.ZodType<CircuitItem> = z.lazy(() =>
  z.union([
    z.object({ parallel: z.array(z.array(CircuitItemSchema).min(1).max(4)).min(2).max(4) }),
    CircuitPartSchema,
  ])
) as z.ZodType<CircuitItem>;

export const CircuitSchema = z.object({
  source: z
    .object({
      type: looseEnum(["battery", "cell", "ac"] as const).transform((t) => t ?? "battery"),
      voltage: z.coerce.number().positive().optional().catch(undefined),
      label: optionalText(16),
    })
    .default({ type: "battery" }),
  /** Components in order around the loop (after the source). A `parallel` item holds 2–4 branches. */
  items: z.array(CircuitItemSchema).min(1).max(8),
  /** Compute and show total resistance, current and each component's current/voltage. */
  showCalculations: flag,
  /** Resistor symbol: "iec" box (default) or "ansi" zig-zag. */
  standard: looseEnum(["iec", "ansi"] as const),
});

export const ChemistrySchema = z.object({
  molecules: z
    .array(
      z.object({
        name: text(40),
        smiles: z.string().trim().min(1).max(300).optional().catch(undefined),
        formula: optionalText(30),
        /** Set on every molecule to draw a reaction: reactants → products. */
        role: looseEnum(["reactant", "product"] as const),
        coefficient: z.coerce.number().int().min(1).max(20).optional().catch(undefined),
        step,
      })
    )
    .min(1)
    .max(6),
  /** Draw every hydrogen (full structural formula). Default: only for small molecules. */
  showHydrogens: flag,
  /** Text over the reaction arrow, e.g. "heat", "H₂SO₄ catalyst". */
  conditions: optionalText(30),
});

export const AtomSchema = z.object({
  /** Symbol, name or atomic number: "Na", "sodium", 11. */
  element: z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().trim().min(1).max(20)),
  /** Ion charge, e.g. 1 for Na⁺, −2 for O²⁻. */
  charge: z.coerce.number().int().min(-3).max(3).optional().catch(undefined),
});

export const LabelledSchema = z.object({
  template: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v), z.string().min(1).max(40)),
  /**
   * Set by the server (never by the model) when the drawing is a sketch from the library,
   * a reference SVG or an AI sketch rather than a built-in template.
   */
  sketch: z.string().regex(/^sk_[a-z0-9]{10,24}$/).optional().catch(undefined),
  /** Parts to label (ids from the template). Empty = label every part. */
  labels: z.array(z.object({ part: localId, text: optionalText(40), step })).max(14).default([]),
});

export const MAP_REGIONS = ["world", "europe", "asia", "africa", "north_america", "south_america", "oceania", "middle_east", "south_asia", "east_asia"] as const;

export const MapSchema = z.object({
  region: looseEnum(MAP_REGIONS),
  /** Countries to highlight. */
  countries: z.array(z.object({ name: text(40), label: optionalText(40), role: looseEnum(ROLES), step })).max(40).optional().catch(undefined),
  markers: z
    .array(z.object({ label: text(30), lat: num.optional().catch(undefined), lon: num.optional().catch(undefined), country: optionalText(40), role: looseEnum(ROLES), step }))
    .max(16)
    .optional()
    .catch(undefined),
  /** Arrows between markers (by label). */
  routes: z.array(z.object({ from: text(30), to: text(30), label: optionalText(30), role: looseEnum(ROLES), step })).max(10).optional().catch(undefined),
});

export const DiagramSpecSchema = z.object({
  title: text(70),
  kind: looseEnum(DIAGRAM_KINDS).transform((k) => k ?? "flowchart"),
  direction: looseEnum(["tb", "lr"] as const),
  nodes: z.array(SpecNodeSchema).max(60).default([]),
  edges: z.array(SpecEdgeSchema).max(80).default([]),
  groups: z.array(SpecGroupSchema).max(6).optional().catch(undefined),
  annotations: z.array(SpecAnnotationSchema).max(12).optional().catch(undefined),
  frames: z.array(SpecFrameSchema).max(8).optional().catch(undefined),
  formulas: z.array(SpecFormulaSchema).max(6).optional().catch(undefined),
  code: SpecCodeSchema.optional().catch(undefined),
  takeaways: z.array(text(110)).max(5).optional().catch(undefined),
  /** Set by the server from the plan's worked example — not by the designer. */
  worked: WorkedSchema.optional().catch(undefined),
  numberLine: block(NumberLineSchema),
  plot: block(PlotSchema),
  geometry: block(GeometrySchema),
  chart: block(ChartSchema),
  table: block(TableSchema),
  venn: block(VennSchema),
  chronology: block(ChronologySchema),
  vectors: block(VectorsSchema),
  circuit: block(CircuitSchema),
  chemistry: block(ChemistrySchema),
  atom: block(AtomSchema),
  labelled: block(LabelledSchema),
  map: block(MapSchema),
  /** The concrete example used (e.g. "array [2,5,8,12,16], target 12") — kept for continuity. */
  example: optionalText(160),
});

export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;
export type SpecNode = z.infer<typeof SpecNodeSchema>;
export type SpecEdge = z.infer<typeof SpecEdgeSchema>;

/** Human/LLM-readable description of the schema, embedded in the designer prompt. */
export const DIAGRAM_SPEC_GUIDE = `{
  "title": string (≤ 70 chars),
  "kind": one of ${DIAGRAM_KINDS.map((k) => `"${k}"`).join(" | ")},
  "direction": "tb" | "lr"            (flowchart/graph only; optional),
  "nodes": [{
     "id": short snake_case id unique in this diagram,
     "label": string (≤ 80 chars, 1–6 words ideal),
     "detail": optional second line (≤ 120 chars),
     "shape": "box" | "rounded" | "diamond" | "circle" | "pill"   (optional),
     "role": "primary" | "secondary" | "accent" | "success" | "warning" | "danger" | "muted"  (optional),
     "parent": parent node id         (tree / mindmap only),
     "side": "left" | "right"         (binary trees only),
     "group": group id                (comparison only),
     "step": teaching step number (1-based) when this node first appears
  }],
  "edges": [{ "from": node id, "to": node id, "label": optional (≤ 48 chars),
              "style": "solid" | "dashed", "directed": boolean (default true), "role": optional, "step": optional }],
  "groups": [{ "id", "label", "role" }]                     (comparison columns),
  "annotations": [{ "target": node id, "text": ≤ 100 chars, "step" }],
  "frames": [{ "caption", "step", "pointers": [{ "label", "index" }], "ranges": [{ "from", "to", "role" }] }]  (array/stack/queue traces; indices are 0-based cell positions),
  "formulas": [{ "latex", "caption", "step" }],
  "code": { "language", "code", "step" },
  "takeaways": [≤ 5 short bullet strings],
  "example": the concrete example data used (string),

  // Data blocks: include ONLY the one matching "kind". Give data, never canvas coordinates.
  "numberLine": { "min", "max", "step"?, "points": [{ "value", "label"?, "role"? }],
                  "jumps": [{ "from", "to" }]   (an operation like 3 + 2 is a jump from 3 to 5),
                  "intervals": [{ "from"?, "to"?, "includeFrom", "includeTo", "label"? }]   (omit from/to for ±∞) },
  "plot": { "xMin", "xMax", "yMin"?, "yMax"?, "xLabel"?, "yLabel"?,
            "functions": [{ "expr": "2x^2 - 3", "label"? }]   (plain math in x: + - * / ^ sin cos tan sqrt abs ln log exp pi),
            "points": [{ "x", "y", "label"? }], "segments": [{ "from": [x,y], "to": [x,y], "label"?, "dashed"? }],
            "showIntersections"?: true },
  "geometry": { "points": [{ "id", "x", "y", "label"? }]   (math coordinates, y up),
                "segments": [{ "from", "to", "label"?, "showLength"? }], "polygons": [{ "vertices": [ids], "role"? }],
                "circles": [{ "center", "radius" | "through" }], "angles": [{ "vertex", "from", "to", "label"?, "showMeasure"? }] },
  "chart": { "type": "bar" | "line" | "pie" | "scatter", "categories": [...], "series": [{ "name", "values": [...] }],
             "points": [{ "x", "y" }] (scatter), "xLabel"?, "yLabel"?, "unit"? },
  "table": { "columns": [...], "rows": [[...], ...], "highlight": [{ "row", "col", "role" }], "rowHeaders"? },
  "venn": { "sets": [{ "id", "label" }] (2–3), "regions": [{ "sets": [ids], "items": [...] }], "universe"? },
  "chronology": { "events": [{ "date": 1914 | "1914-07-28" | "500 BCE", "label" }], "periods": [{ "from", "to", "label" }] },
  "vectors": { "mode": "free_body" | "addition" | "components", "object"?, "unit"? ("N", "m/s"), "incline"? (slope degrees),
               "vectors": [{ "label", "magnitude", "direction": "up"|"down"|"left"|"right"|"normal"|"up_slope"|"down_slope"|"into_slope"
                             OR "angle" (degrees counter-clockwise from right) }], "showResultant"? },
  "circuit": { "source": { "type": "battery" | "cell" | "ac", "voltage"? }, "standard"?: "iec" | "ansi",
               "items": [ { "type": "resistor"|"bulb"|"switch"|"capacitor"|"ammeter"|"voltmeter"|"diode"|"led"|"fuse"|"motor"|"buzzer",
                            "label"?, "value"? (ohms), "open"? (switch) }
                          | { "parallel": [[items of branch 1], [items of branch 2], ...] } ]   (in order around the loop),
               "showCalculations"? (code computes total resistance, current, each voltage) },
  "chemistry": { "molecules": [{ "name", "smiles" (valid SMILES), "formula"?, "role"?: "reactant" | "product", "coefficient"? }],
                 "showHydrogens"?, "conditions"? },
  "atom": { "element": "Na" | "sodium" | 11, "charge"? },
  "labelled": { "template": template id, "labels": [{ "part": part id, "text"? }] (empty = label all parts) },
  "map": { "region"?: ${MAP_REGIONS.map((r) => `"${r}"`).join(" | ")},
           "countries": [{ "name", "label"?, "role"? }] (highlighted), "markers": [{ "label", "lat", "lon", "country"? }],
           "routes": [{ "from": marker label, "to": marker label, "label"? }] }
  ("cycle" uses "nodes" in order; arrows are added automatically)
}`;
