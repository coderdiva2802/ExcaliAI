// ─────────────────────────────────────────────────────────
// Semantic validation + deterministic repair of DiagramSpecs.
//
// zod guarantees the *shape* of the LLM output; this module
// guarantees it *makes sense*: every reference resolves, ids
// are unique and safe, trees are acyclic, array indices are in
// range, steps line up with the explanation, and sizes stay
// readable.  Minor problems are repaired and recorded; if the
// result is unusable it is flagged `critical` so the caller
// can ask the model for one repair round (or give up safely).
// ─────────────────────────────────────────────────────────

import { fixArithmetic } from "./arithmetic.js";
import type { DiagramSpec, SpecEdge, SpecNode, Worked } from "./spec.js";
import { hasQuantContent, reconcileKind, validateQuant } from "./validateQuant.js";

export interface ValidationResult {
  spec: DiagramSpec;
  issues: string[];
  critical: string[];
}

/** Max nodes per kind — beyond this a diagram stops being readable. */
const MAX_NODES: Record<string, number> = {
  array: 16, linked_list: 10, stack: 10, queue: 10,
  sequence: 6, layers: 9, timeline: 10, comparison: 16,
  tree: 31, mindmap: 20, flowchart: 22, graph: 18, formula: 0, cycle: 8,
};

const LIST_KINDS = new Set(["array", "linked_list", "stack", "queue"]);
const NO_CODE_KINDS = new Set(["vectors", "circuit", "molecule", "atom", "labelled_diagram", "map"]);

function slug(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return s || "n";
}

export function validateSpec(input: DiagramSpec, stepCount: number): ValidationResult {
  const issues: string[] = [];
  const critical: string[] = [];
  const maxStep = Math.max(1, stepCount);
  const clampStep = (s: number | undefined, fallback = 1) =>
    Math.min(maxStep, Math.max(1, s ?? fallback));

  const spec: DiagramSpec = reconcileKind(structuredClone(input), issues);

  // ── formula kind needs formulas; otherwise fall back to a flowchart ──
  if (spec.kind === "formula" && !spec.formulas?.length) {
    issues.push('kind "formula" without formulas → treated as flowchart');
    spec.kind = "flowchart";
  }

  // ── Nodes: safe unique ids, non-empty labels ──
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const nodes: SpecNode[] = [];
  for (const node of spec.nodes) {
    const label = node.label.trim();
    if (!label && !LIST_KINDS.has(spec.kind)) {
      issues.push(`node "${node.id}" has no label → dropped`);
      continue;
    }
    let id = slug(node.id);
    if (used.has(id)) {
      let i = 2;
      while (used.has(`${id}_${i}`)) i++;
      issues.push(`duplicate node id "${node.id}" → renamed`);
      id = `${id}_${i}`;
    }
    used.add(id);
    if (!idMap.has(node.id)) idMap.set(node.id, id);
    idMap.set(id, id);
    nodes.push({ ...node, id, label: label || " ", step: clampStep(node.step) });
  }

  const limit = MAX_NODES[spec.kind] ?? 22;
  if (nodes.length > limit && limit > 0) {
    issues.push(`${nodes.length} nodes exceeds readable limit ${limit} for ${spec.kind} → truncated`);
    nodes.length = limit;
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const resolve = (ref: string | undefined) => {
    if (ref === undefined) return undefined;
    const id = idMap.get(ref) ?? idMap.get(slug(ref));
    return id && nodeIds.has(id) ? id : undefined;
  };

  // ── Tree / mindmap hierarchy ──
  if (spec.kind === "tree" || spec.kind === "mindmap") {
    // Derive parents from edges when the model used edges instead of `parent`.
    const hasParents = nodes.some((n) => n.parent);
    if (!hasParents) {
      for (const e of spec.edges) {
        const from = resolve(e.from);
        const child = nodes.find((n) => n.id === resolve(e.to));
        if (from && child && !child.parent && child.id !== from) child.parent = from;
      }
    }
    for (const n of nodes) {
      if (n.parent === undefined) continue;
      const p = resolve(n.parent);
      if (!p || p === n.id) {
        issues.push(`node "${n.id}" has unknown parent "${n.parent}" → made a root`);
        n.parent = undefined;
      } else n.parent = p;
    }
    // Break cycles by walking up from every node.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const seen = new Set<string>([n.id]);
      let cur = n.parent ? byId.get(n.parent) : undefined;
      while (cur) {
        if (seen.has(cur.id)) {
          issues.push(`cycle in hierarchy at "${n.id}" → broken`);
          n.parent = undefined;
          break;
        }
        seen.add(cur.id);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
    }
    // A mindmap needs exactly one center.
    if (spec.kind === "mindmap") {
      const roots = nodes.filter((n) => !n.parent);
      for (const extra of roots.slice(1)) extra.parent = roots[0].id;
    }
    // Children appear no earlier than their parents.
    for (const n of nodes) {
      const p = n.parent ? byId.get(n.parent) : undefined;
      if (p && (n.step ?? 1) < (p.step ?? 1)) n.step = p.step;
    }
    // Hierarchy edges are implied by `parent`; only keep extra cross-links.
    spec.edges = spec.edges.filter((e) => {
      const from = resolve(e.from);
      const to = resolve(e.to);
      return !(to && byId.get(to)?.parent === from);
    });
  }

  // ── Comparison groups ──
  if (spec.kind === "comparison") {
    let groups = spec.groups ?? [];
    if (groups.length === 0) {
      const names = [...new Set(nodes.map((n) => n.group).filter((g): g is string => !!g))];
      groups = names.map((g) => ({ id: g, label: g.replace(/_/g, " "), role: undefined }));
      if (groups.length) issues.push("comparison groups derived from node.group values");
    }
    const groupIds = new Set(groups.map((g) => g.id));
    if (groups.length < 2) critical.push("comparison needs at least 2 groups (columns)");
    for (const n of nodes) {
      if (!n.group || !groupIds.has(n.group)) {
        if (n.group) issues.push(`node "${n.id}" references unknown group → moved to first column`);
        n.group = groups[0]?.id;
      }
    }
    spec.groups = groups;
  }

  // ── Edges ──
  const edges: SpecEdge[] = [];
  const edgeKeys = new Set<string>();
  let dropped = 0;
  for (const e of spec.edges) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (!from || !to) {
      dropped++;
      issues.push(`edge ${e.from}→${e.to} references a missing node → dropped`);
      continue;
    }
    if (from === to && spec.kind !== "sequence" && spec.kind !== "graph") {
      issues.push(`self-loop on "${from}" → dropped`);
      continue;
    }
    const key = `${from}>${to}>${e.label ?? ""}`;
    if (edgeKeys.has(key) && spec.kind !== "sequence") continue;
    edgeKeys.add(key);
    const endpointStep = Math.max(
      nodes.find((n) => n.id === from)?.step ?? 1,
      nodes.find((n) => n.id === to)?.step ?? 1
    );
    edges.push({ ...e, from, to, step: Math.max(clampStep(e.step, endpointStep), endpointStep) });
  }
  if (spec.edges.length >= 3 && dropped / spec.edges.length > 0.34) {
    critical.push(`${dropped} of ${spec.edges.length} edges reference nodes that do not exist`);
  }
  if (spec.kind === "layers" && edges.length) {
    issues.push("edges are not drawn for layer diagrams");
  }
  if (spec.kind === "sequence" && nodes.length >= 2 && edges.length === 0) {
    critical.push("sequence diagram has participants but no messages (edges)");
  }

  // ── Annotations ──
  const annotations = (spec.annotations ?? []).flatMap((a) => {
    const target = resolve(a.target);
    if (!target) {
      issues.push(`annotation targets missing node "${a.target}" → dropped`);
      return [];
    }
    const targetStep = nodes.find((n) => n.id === target)?.step ?? 1;
    return [{ ...a, target, step: Math.max(clampStep(a.step, targetStep), targetStep) }];
  });

  // ── Array frames: indices must address real cells ──
  let frames = spec.frames;
  if (frames?.length) {
    if (!LIST_KINDS.has(spec.kind)) {
      issues.push(`frames are only supported for list kinds → ignored`);
      frames = undefined;
    } else {
      const n = nodes.length;
      frames = frames.map((f) => ({
        ...f,
        step: clampStep(f.step),
        pointers: (f.pointers ?? []).filter((p) => {
          const ok = p.index >= 0 && p.index < n;
          if (!ok) issues.push(`pointer "${p.label}" index ${p.index} out of range 0..${n - 1} → dropped`);
          return ok;
        }),
        ranges: (f.ranges ?? []).flatMap((r) => {
          const from = Math.max(0, Math.min(r.from, r.to));
          const to = Math.min(n - 1, Math.max(r.from, r.to));
          if (from > to) {
            issues.push(`range ${r.from}..${r.to} out of bounds → dropped`);
            return [];
          }
          return [{ ...r, from, to }];
        }),
      }));
    }
  }

  const formulas = spec.formulas?.map((f) => ({ ...f, step: clampStep(f.step) }));
  let code = spec.code ? { ...spec.code, step: clampStep(spec.code.step) } : undefined;
  if (code && !code.code.includes("\n") && code.code.includes("\\n")) {
    issues.push("code had escaped newlines → unescaped");
    code = { ...code, code: code.code.replace(/\\n/g, "\n").replace(/\\t/g, "  ") };
  }
  if (code && NO_CODE_KINDS.has(spec.kind)) {
    issues.push(`a code panel adds nothing to a "${spec.kind}" diagram (its values are computed) → dropped`);
    code = undefined;
  }

  const worked = spec.worked ? validateWorked(spec.worked, stepCount, issues) : undefined;

  if (nodes.length === 0 && !formulas?.length && !code && !worked && !hasQuantContent(spec)) {
    critical.push("the diagram has no nodes, formulas, code or data to draw");
  }
  if (spec.kind === "sequence" && nodes.length > 0 && nodes.length < 2) {
    critical.push("a sequence diagram needs at least 2 participants");
  }

  // Kind-specific data checks; derived values (jump sizes, percentages, angles) are computed by code.
  const checked = validateQuant({ ...spec, nodes, edges, annotations, frames, formulas, code, worked }, issues, critical);
  return { spec: checked, issues, critical };
}

/**
 * Worked example: teaching steps clamped and kept in order (a step never appears before the
 * previous one), and every "expression = result" checked — a wrong result is corrected.
 */
export function validateWorked(w: Worked, stepCount: number, issues: string[]): Worked {
  const max = Math.max(1, stepCount);
  const n = w.steps.length;
  let last = 1;
  const fix = (line: string, where: string) => {
    const r = fixArithmetic(line);
    for (const f of r.fixes) issues.push(`arithmetic: ${where} "${f.from}" is wrong → corrected to ${f.to}`);
    return r.text;
  };
  const steps = w.steps.map((s, i) => {
    // Missing steps: spread the example over the later teaching steps.
    const wanted = s.step ?? Math.min(max, Math.max(1, Math.ceil(max / 2)) + Math.floor((i * (max - Math.ceil(max / 2) + 1)) / n));
    last = Math.max(last, Math.min(max, Math.max(1, wanted)));
    return { ...s, step: last, lines: s.lines.map((l) => fix(l, `step ${i + 1}`)) };
  });
  let figure = w.figure;
  if (figure) {
    const ids = new Set(figure.nodes.map((n) => n.id));
    const edges = figure.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    if (edges.length < figure.edges.length) issues.push(`worked example figure: ${figure.edges.length - edges.length} edge(s) referenced missing nodes → dropped`);
    figure = { ...figure, nodes: figure.nodes.filter((n, i) => figure!.nodes.findIndex((m) => m.id === n.id) === i), edges };
  }
  return { ...w, steps, ...(figure ? { figure } : {}), ...(w.answer ? { answer: fix(w.answer, "answer") } : {}) };
}
