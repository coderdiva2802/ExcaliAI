// ─────────────────────────────────────────────────────────
// Context / Memory Manager
//
// Owns the structured, persistent state of a lesson:
//   • conversation   — compact turn records (not raw transcripts)
//   • explanation    — topic, concepts introduced, examples used
//   • canvas         — every generated diagram with its spec,
//                      compiled element ids and current bounds
//
// Each turn it reconciles memory with the canvas the client
// actually has (the user may have deleted, moved or drawn
// things), then renders a bounded, structured context block
// for the planner.  Raw history is never sent wholesale.
// ─────────────────────────────────────────────────────────

import type { CanvasElement, CreateAction, DSLAction } from "@excaliai/shared";
import type { DiagramSpec } from "../diagram/spec.js";
import type { Rect } from "../diagram/compiler.js";
import { boundsOf } from "../diagram/compiler.js";

export const INTENTS = [
  "new_topic",          // a new subject
  "follow_up",          // continue / go deeper on the current topic (new diagram if useful)
  "modify_visual",      // change an existing diagram (simplify, relabel, restyle, reorder)
  "extend_visual",      // add to an existing diagram (an example, a step, a node)
  "remove_from_visual", // remove part of an existing diagram
  "answer_only",        // answer in words, optionally highlighting existing elements
  "clarify",            // genuinely ambiguous — ask the user
] as const;
export type Intent = (typeof INTENTS)[number];
export const TARGETED_INTENTS: ReadonlySet<Intent> = new Set(["modify_visual", "extend_visual", "remove_from_visual"]);

export interface ExplanationStep {
  title: string;
  narration: string;
}

export interface TurnRecord {
  id: number;
  at: string;
  user: string;
  resolvedRequest: string;
  intent: Intent;
  summary: string;
  steps: ExplanationStep[];
  diagramId?: string;
  question?: string;
}

export interface DiagramRecord {
  id: string;
  title: string;
  kind: string;
  spec: DiagramSpec;
  /** The exact create actions last sent for this diagram (used for diffs). */
  compiled: CreateAction[];
  bbox: Rect;
  stepTitles: string[];
  createdTurn: number;
  updatedTurn: number;
  status: "on_canvas" | "removed";
}

export interface LessonMemory {
  version: 1;
  lessonId: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  turns: TurnRecord[];
  /** Folded summary of turns trimmed from `turns`. */
  earlierSummary: string;
  diagrams: DiagramRecord[];
  activeDiagramId: string | null;
  concepts: string[];
  examples: string[];
  pendingQuestion: string | null;
  nextDiagramSeq: number;
  /** Undo stack: the lesson as it was before each of the last few turns (newest last). */
  history?: Snapshot[];
}

/** A diagram a turn didn't change is stored as a reference to the next newer state, not copied. */
export interface DiagramRef { id: string; ref: true }
export type Snapshot = Omit<LessonMemory, "history" | "diagrams"> & { diagrams: Array<DiagramRecord | DiagramRef> };

export const MAX_UNDO = 5;
const isRef = (d: DiagramRecord | DiagramRef): d is DiagramRef => "ref" in d;

/** The lesson as it stands now, without its undo stack (taken at the start of a turn). */
export function snapshotOf(memory: LessonMemory): LessonMemory {
  const { history, ...rest } = memory;
  void history;
  return structuredClone(rest);
}

/** Record `before` (the state at the start of this turn) on `memory`'s undo stack. */
export function pushUndo(memory: LessonMemory, before: LessonMemory): void {
  const current = new Map(memory.diagrams.map((d) => [d.id, JSON.stringify(d)]));
  const { history, ...rest } = before;
  void history;
  const compact: Snapshot = {
    ...rest,
    diagrams: before.diagrams.map((d) => (current.get(d.id) === JSON.stringify(d) ? { id: d.id, ref: true as const } : d)),
  };
  memory.history = [...(memory.history ?? []), compact].slice(-MAX_UNDO);
}

export interface UndoResult {
  memory: LessonMemory;
  /** Canvas actions that put the board back the way it was before the undone turn. */
  actions: DSLAction[];
  /** The user message of the undone turn (so the client can drop the matching note). */
  undone: string | null;
}

/** Roll the lesson back one turn, or null when there is nothing to undo. */
export function undoLastTurn(memory: LessonMemory): UndoResult | null {
  const history = memory.history ?? [];
  const snap = history.at(-1);
  if (!snap) return null;
  const restored: LessonMemory = {
    ...structuredClone(snap),
    diagrams: snap.diagrams.flatMap((d) => {
      if (!isRef(d)) return [structuredClone(d)];
      const now = memory.diagrams.find((x) => x.id === d.id);
      return now ? [structuredClone(now)] : [];
    }),
    history: history.slice(0, -1),
  };

  const lastTurn = memory.turns.at(-1);
  const undoneTurn = lastTurn && !snap.turns.some((t) => t.id === lastTurn.id) ? lastTurn : undefined;
  const actions: DSLAction[] = [];
  const redraw = (d: DiagramRecord) => {
    for (const a of d.compiled) actions.push({ action: "delete_element", elementId: a.id });
  };
  let focus: string | null = null;
  for (const d of memory.diagrams) {
    const before = restored.diagrams.find((x) => x.id === d.id);
    // An "answer only" turn recolours elements for emphasis: redraw its diagram to clear that.
    const highlighted = undoneTurn?.intent === "answer_only" && undoneTurn.diagramId === d.id;
    if (before && JSON.stringify(before) === JSON.stringify(d) && !highlighted) continue;
    if (d.status === "on_canvas") redraw(d);
    if (before?.status === "on_canvas") {
      actions.push(...before.compiled);
      focus = before.id;
    }
  }
  for (const d of restored.diagrams) {
    if (!memory.diagrams.some((x) => x.id === d.id) && d.status === "on_canvas") {
      actions.push(...d.compiled);
      focus = d.id;
    }
  }
  if (focus) actions.push({ action: "focus_diagram", diagramId: focus });
  restored.updatedAt = new Date().toISOString();
  return { memory: restored, actions, undone: undoneTurn?.user ?? null };
}

const MAX_TURNS = 12;
const MAX_CONCEPTS = 40;
const MAX_EXAMPLES = 10;

export function newMemory(lessonId: string): LessonMemory {
  const now = new Date().toISOString();
  return {
    version: 1,
    lessonId,
    topic: "",
    createdAt: now,
    updatedAt: now,
    turns: [],
    earlierSummary: "",
    diagrams: [],
    activeDiagramId: null,
    concepts: [],
    examples: [],
    pendingQuestion: null,
    nextDiagramSeq: 1,
  };
}

// ── Canvas reconciliation ──────────────────────────────

export interface CanvasView {
  /** Elements grouped by the diagram they belong to. */
  byDiagram: Map<string, CanvasElement[]>;
  /** Elements the user drew themselves. */
  userElements: CanvasElement[];
}

export function viewCanvas(elements: CanvasElement[]): CanvasView {
  const byDiagram = new Map<string, CanvasElement[]>();
  const userElements: CanvasElement[] = [];
  for (const el of elements) {
    if (el.diagramId) {
      const list = byDiagram.get(el.diagramId) ?? [];
      list.push(el);
      byDiagram.set(el.diagramId, list);
    } else userElements.push(el);
  }
  return { byDiagram, userElements };
}

/** Sync memory with what is really on the canvas. */
export function reconcile(memory: LessonMemory, view: CanvasView): void {
  for (const d of memory.diagrams) {
    const present = view.byDiagram.get(d.id);
    if (!present?.length) {
      d.status = "removed";
      continue;
    }
    d.status = "on_canvas";
    d.bbox = boundsOf(present) ?? d.bbox;
  }
  if (!memory.diagrams.some((d) => d.id === memory.activeDiagramId && d.status === "on_canvas")) {
    const latest = [...memory.diagrams].reverse().find((d) => d.status === "on_canvas");
    memory.activeDiagramId = latest?.id ?? null;
  }
}

/**
 * True when every element we last drew for a diagram is still on the
 * canvas exactly where we put it — then unchanged elements can be
 * reused when the diagram is revised.
 */
export function diagramUntouched(d: DiagramRecord, view: CanvasView): boolean {
  const present = new Map((view.byDiagram.get(d.id) ?? []).map((e) => [e.id, e]));
  for (const a of d.compiled) {
    const el = present.get(a.id);
    if (!el) return false;
    if ("x" in a && typeof a.x === "number" && (Math.abs(el.x - a.x) > 2 || Math.abs(el.y - (a as { y: number }).y) > 2)) {
      return false;
    }
  }
  return true;
}

export function allocateDiagramId(memory: LessonMemory, view: CanvasView): string {
  let id: string;
  do {
    id = `d${memory.nextDiagramSeq++}`;
  } while (view.byDiagram.has(id) || memory.diagrams.some((d) => d.id === id));
  return id;
}

export function onCanvasDiagrams(memory: LessonMemory): DiagramRecord[] {
  return memory.diagrams.filter((d) => d.status === "on_canvas");
}

// ── Recording ──────────────────────────────────────────

export function recordTurn(memory: LessonMemory, turn: Omit<TurnRecord, "id" | "at">): TurnRecord {
  const record: TurnRecord = {
    ...turn,
    id: (memory.turns.at(-1)?.id ?? 0) + 1,
    at: new Date().toISOString(),
  };
  memory.turns.push(record);
  while (memory.turns.length > MAX_TURNS) {
    const old = memory.turns.shift()!;
    memory.earlierSummary = `${memory.earlierSummary} ${old.summary}`.trim().slice(-1500);
  }
  memory.updatedAt = record.at;
  return record;
}

export function addConcepts(memory: LessonMemory, concepts: string[]): void {
  const seen = new Set(memory.concepts.map((c) => c.toLowerCase()));
  for (const c of concepts) {
    const v = c.trim();
    if (v && !seen.has(v.toLowerCase())) {
      memory.concepts.push(v);
      seen.add(v.toLowerCase());
    }
  }
  memory.concepts = memory.concepts.slice(-MAX_CONCEPTS);
}

export function addExample(memory: LessonMemory, example: string | undefined): void {
  if (!example?.trim()) return;
  memory.examples = [...memory.examples.filter((e) => e !== example), example].slice(-MAX_EXAMPLES);
}

// ── Context rendering for prompts ──────────────────────

/** Compact, human-readable description of a diagram's content. */
export function describeDiagram(d: DiagramRecord, maxNodes = 14): string {
  const nodes = d.spec.nodes.slice(0, maxNodes).map((n) => `${n.id}="${n.label}"`).join(", ");
  const more = d.spec.nodes.length > maxNodes ? ` (+${d.spec.nodes.length - maxNodes} more)` : "";
  const steps = d.stepTitles.length ? ` | steps: ${d.stepTitles.map((s, i) => `${i + 1}.${s}`).join(" ")}` : "";
  const example = d.spec.example ? ` | example: ${d.spec.example}` : "";
  const w = d.spec.worked;
  const worked = w ? ` | worked example (${w.steps.length} steps): ${w.problem.slice(0, 160)}${w.answer ? ` → ${w.answer.slice(0, 80)}` : ""}` : "";
  return `"${d.title}" [${d.kind}] nodes: ${nodes || "(none)"}${more}${steps}${example}${worked}`;
}

function describeUserElements(elements: CanvasElement[]): string {
  if (!elements.length) return "none";
  const labelled = elements
    .filter((e) => e.text || e.latex || e.code)
    .slice(0, 12)
    .map((e) => `${e.type} "${(e.text || e.latex || e.code || "").slice(0, 60)}"`);
  return `${elements.length} element(s)${labelled.length ? `; labelled: ${labelled.join("; ")}` : ""}`;
}

export function buildPlannerContext(memory: LessonMemory, view: CanvasView): string {
  const diagrams = onCanvasDiagrams(memory);
  const lines: string[] = [];
  lines.push(`CURRENT TOPIC: ${memory.topic || "(none yet — this is the first request)"}`);
  if (memory.earlierSummary) lines.push(`EARLIER IN THIS LESSON: ${memory.earlierSummary}`);
  if (memory.concepts.length) lines.push(`CONCEPTS ALREADY EXPLAINED: ${memory.concepts.join(", ")}`);
  if (memory.examples.length) lines.push(`EXAMPLES ALREADY USED: ${memory.examples.join(" || ")}`);

  lines.push("RECENT TURNS (oldest → newest):");
  if (!memory.turns.length) lines.push("  (none)");
  for (const t of memory.turns.slice(-8)) {
    const diag = t.diagramId ? ` → diagram ${t.diagramId}` : "";
    const q = t.question ? ` (tutor asked: "${t.question}")` : "";
    lines.push(`  [turn ${t.id}] user: "${t.user.slice(0, 200)}" → ${t.intent}: ${t.summary}${diag}${q}`);
  }

  lines.push("DIAGRAMS CURRENTLY ON THE CANVAS (the only valid targetDiagramId values):");
  if (!diagrams.length) lines.push("  (none)");
  for (const d of diagrams) {
    const active = d.id === memory.activeDiagramId ? "  ← ACTIVE (most recent)" : "";
    lines.push(`  - ${d.id}: ${describeDiagram(d)}${active}`);
  }
  lines.push(`USER-DRAWN ELEMENTS: ${describeUserElements(view.userElements)}`);
  if (memory.pendingQuestion) lines.push(`THE TUTOR'S LAST MESSAGE WAS A QUESTION: "${memory.pendingQuestion}"`);
  return lines.join("\n");
}
