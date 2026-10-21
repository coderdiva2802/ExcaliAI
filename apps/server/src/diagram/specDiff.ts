// ─────────────────────────────────────────────────────────
// Deterministic description of what an edit actually changed.
//
// Used to (1) detect no-op edits (the model "revised" a
// diagram without changing it) and (2) tell the student what
// changed on the canvas in terms that are guaranteed true —
// instead of trusting the model's own claims about its edit.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec, SpecNode } from "./spec.js";

const q = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;
const listOf = (labels: string[], max = 4) =>
  labels.slice(0, max).map(q).join(", ") + (labels.length > max ? ` and ${labels.length - max} more` : "");

export function describeSpecChanges(prev: DiagramSpec, next: DiagramSpec): string[] {
  const changes: string[] = [];
  if (prev.kind !== next.kind) changes.push(`Switched the diagram from a ${prev.kind.replace("_", " ")} to a ${next.kind.replace("_", " ")}.`);

  // Match nodes by id, falling back to identical labels (models sometimes rename ids).
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const prevByLabel = new Map(prev.nodes.map((n) => [n.label.toLowerCase(), n]));
  const matched = new Set<SpecNode>();
  const added: string[] = [];
  const renamed: string[] = [];
  for (const n of next.nodes) {
    const p = prevById.get(n.id) ?? prevByLabel.get(n.label.toLowerCase());
    if (!p || matched.has(p)) {
      added.push(n.label);
      continue;
    }
    matched.add(p);
    if (p.label !== n.label) renamed.push(`${q(p.label)} → ${q(n.label)}`);
    else if ((p.detail ?? "") !== (n.detail ?? "")) renamed.push(`details of ${q(n.label)}`);
  }
  const removed = prev.nodes.filter((n) => !matched.has(n)).map((n) => n.label);

  if (removed.length) changes.push(`Removed ${listOf(removed)}.`);
  if (added.length) changes.push(`Added ${listOf(added)}.`);
  if (renamed.length) changes.push(`Updated ${renamed.slice(0, 3).join(", ")}${renamed.length > 3 ? ` and ${renamed.length - 3} more` : ""}.`);

  // Edges are compared in order per endpoint pair, so a changed label is a relabel, not add+remove.
  const byPair = (edges: DiagramSpec["edges"]) => {
    const m = new Map<string, string[]>();
    for (const e of edges) m.set(`${e.from}>${e.to}`, [...(m.get(`${e.from}>${e.to}`) ?? []), e.label ?? ""]);
    return m;
  };
  const prevPairs = byPair(prev.edges);
  const nextPairs = byPair(next.edges);
  let edgesAdded = 0, edgesRemoved = 0, relabeled = 0;
  for (const key of new Set([...prevPairs.keys(), ...nextPairs.keys()])) {
    const a = prevPairs.get(key) ?? [];
    const b = nextPairs.get(key) ?? [];
    const common = Math.min(a.length, b.length);
    for (let i = 0; i < common; i++) if (a[i] !== b[i]) relabeled++;
    edgesAdded += Math.max(0, b.length - a.length);
    edgesRemoved += Math.max(0, a.length - b.length);
  }
  if (edgesAdded || edgesRemoved || relabeled) {
    const parts = [
      edgesAdded && `${edgesAdded} added`,
      edgesRemoved && `${edgesRemoved} removed`,
      relabeled && `${relabeled} relabeled`,
    ].filter(Boolean);
    changes.push(`Connections: ${parts.join(", ")}.`);
  }

  const count = (a?: unknown[]) => a?.length ?? 0;
  const delta = (name: string, a: number, b: number) => {
    if (b > a) changes.push(`Added ${b - a} ${name}${b - a > 1 ? "s" : ""}.`);
    else if (a > b) changes.push(`Removed ${a - b} ${name}${a - b > 1 ? "s" : ""}.`);
  };
  delta("trace step", count(prev.frames), count(next.frames));
  delta("annotation", count(prev.annotations), count(next.annotations));
  delta("formula", count(prev.formulas), count(next.formulas));
  if ((prev.code?.code ?? "") !== (next.code?.code ?? "")) changes.push(next.code ? (prev.code ? "Updated the code." : "Added code.") : "Removed the code.");
  if (JSON.stringify(prev.frames ?? []) !== JSON.stringify(next.frames ?? []) && count(prev.frames) === count(next.frames) && count(next.frames)) {
    changes.push("Updated the trace steps.");
  }
  if (JSON.stringify(prev.takeaways ?? []) !== JSON.stringify(next.takeaways ?? [])) changes.push("Updated the key takeaways.");
  if (JSON.stringify(prev.worked ?? null) !== JSON.stringify(next.worked ?? null)) {
    changes.push(!next.worked ? "Removed the worked example." : !prev.worked ? `Added a worked example (${next.worked.steps.length} steps).` : `Updated the worked example (${next.worked.steps.length} steps).`);
  }
  if (changes.length === 0 && prev.title !== next.title) changes.push(`Retitled it ${q(next.title)}.`);
  return changes;
}

/** Heuristic: is this edit request purely a removal? */
export function isRemovalRequest(text: string): boolean {
  return /\b(remove|delete|drop|get rid of|take out|erase|without)\b/i.test(text) &&
    !/\b(add|insert|replace|swap|rename|change|instead)\b/i.test(text);
}

/**
 * A removal may only remove. Strip any node the model invented (and the edges /
 * annotations that depend on it) so a "remove X" request can never add content.
 */
export function restrictToExisting(prev: DiagramSpec, next: DiagramSpec): { spec: DiagramSpec; stripped: string[] } {
  const prevIds = new Set(prev.nodes.map((n) => n.id));
  const prevLabels = new Set(prev.nodes.map((n) => n.label.toLowerCase()));
  const keep = next.nodes.filter((n) => prevIds.has(n.id) || prevLabels.has(n.label.toLowerCase()));
  const ids = new Set(keep.map((n) => n.id));
  const stripped = next.nodes.filter((n) => !ids.has(n.id)).map((n) => n.label);
  return {
    stripped,
    spec: {
      ...next,
      nodes: keep.map((n) => (n.parent && !ids.has(n.parent) ? { ...n, parent: undefined } : n)),
      edges: next.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      // Only annotations that already existed survive a removal.
      annotations: next.annotations?.filter(
        (a) => ids.has(a.target) && (prev.annotations ?? []).some((p) => p.target === a.target && p.text === a.text)
      ),
      frames: next.frames && prev.frames ? next.frames.slice(0, prev.frames.length) : prev.frames ? next.frames : undefined,
      formulas: next.formulas && prev.formulas ? next.formulas.slice(0, prev.formulas.length) : undefined,
      code: prev.code ? next.code : undefined,
    },
  };
}
