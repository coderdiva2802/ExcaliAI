// ─────────────────────────────────────────────────────────
// Tutor Agent — the turn orchestrator.
//
//   USER MESSAGE + CANVAS
//     → Context Manager   (load memory, reconcile with canvas)
//     → Planner           (intent, references, explanation)      [LLM, validated]
//     → Visual Planner    (semantic DiagramSpec)                 [LLM, validated + repaired]
//     → Layout Engine     (deterministic geometry)
//     → Compiler          (DSL actions, diff for revisions)
//     → Canvas Gate       (schema / reference / geometry checks)
//     → SSE stream        (narration + actions, step by step)
//     → Context Manager   (record turn, diagrams, concepts; persist)
//
// The LLM never emits canvas operations. Each stage has one
// responsibility, and every hand-off is a validated structure.
// ─────────────────────────────────────────────────────────

import type { CanvasState, CreateAction, DSLAction, SSEEvent } from "@excaliai/shared";
import { config } from "../config.js";
import { createGateway, type AIGateway, type AIResponseMeta } from "../llm/gateway.js";
import { redact } from "../llm/types.js";
import { LLMError, userMessageFor } from "../llm/errors.js";
import { layoutDiagram } from "../diagram/layout.js";
import { chooseOrigin, compileDiagram, diffDiagram, elementId, PALETTE } from "../diagram/compiler.js";
import { gateActions } from "../diagram/canvasValidate.js";
import { describeSpecChanges, isRemovalRequest, restrictToExisting } from "../diagram/specDiff.js";
import { validateSpec } from "../diagram/validate.js";
import { fixArithmetic } from "../diagram/arithmetic.js";
import { DiagramSpecSchema, type DiagramSpec } from "../diagram/spec.js";
import type { LessonRepository } from "../storage/lessonRepository.js";
import { PlannerAgent, type Plan } from "./PlannerAgent.js";
import { VisualPlannerAgent } from "./VisualPlannerAgent.js";
import { checkNarration } from "./narrationCheck.js";
import { SketchError, Sketcher } from "../sketch/Sketcher.js";
import type { SketchRecord } from "../sketch/store.js";
import {
  TARGETED_INTENTS,
  addConcepts,
  addExample,
  allocateDiagramId,
  buildPlannerContext,
  diagramUntouched,
  newMemory,
  pushUndo,
  reconcile,
  recordTurn,
  snapshotOf,
  viewCanvas,
  type DiagramRecord,
  type LessonMemory,
} from "./memory.js";

export type Emit = (event: SSEEvent) => void;

/** Provider/model metadata for the debug panel — only when explicitly enabled (dev default). */
function emitMeta(emit: Emit, meta: AIResponseMeta): void {
  if (config.ai.exposeMeta) emit({ type: "meta", ...meta });
}

const STEP_PAUSE_MS = 700;
const HISTORICAL = /\b(1[0-8]\d\d|19[0-8]\d|empire|ancient|medieval|war|ww ?(i|ii|1|2)|colonial|historic(al)?|century|kingdom|dynasty|silk road|cold war)\b/i;
const REALISTIC_REQUEST =
  /\b(labell?ed (diagram|drawing|picture) of|anatom(y|ical)|realistic|picture of|drawing of|what does .{1,40} look like|map of)\b/i;

export class TutorAgent {
  private planner: PlannerAgent;
  private visual: VisualPlannerAgent;
  private sketcher: Sketcher;
  readonly demo: boolean;

  constructor(private repo: LessonRepository, plannerAI?: AIGateway, designerAI?: AIGateway) {
    const p = plannerAI ?? createGateway("planner");
    const d = designerAI ?? createGateway("designer");
    this.planner = new PlannerAgent(p);
    this.visual = new VisualPlannerAgent(d);
    this.sketcher = new Sketcher(d, p);
    this.demo = p.isDemo;
  }

  async runTurn(lessonId: string, message: string, canvas: CanvasState, emit: Emit, signal: AbortSignal): Promise<void> {
    const memory = (await this.repo.load(lessonId)) ?? newMemory(lessonId);
    const view = viewCanvas(canvas.elements);
    reconcile(memory, view);
    const before = snapshotOf(memory); // for "undo last turn"

    // ── 1. Understand + plan ──
    emit({ type: "progress", stage: "understanding", label: "Understanding your question" });
    let plan: Plan;
    try {
      const planned = await this.planner.plan(memory, buildPlannerContext(memory, view), message, signal);
      plan = planned.plan;
      emitMeta(emit, planned.meta);
    } catch (err) {
      if (signal.aborted) return;
      console.error("❌ planner failed:", redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
      emit({ type: "error", ...userMessageFor(err) });
      return;
    }
    console.log(`🧭 intent=${plan.intent} target=${plan.targetDiagramId ?? "-"} kind=${plan.visualKind ?? "-"} steps=${plan.steps.length}${plan.workedExample ? ` worked=${plan.workedExample.steps.length}` : ""}`);
    plan = narrateWorkedSteps(plan);
    // Arithmetic in the narration is checked like the worked example's (the notes are what students copy).
    plan = { ...plan, steps: plan.steps.map((s) => {
      const r = fixArithmetic(s.narration);
      for (const f of r.fixes) console.log(`[AI] narration arithmetic "${f.from}" → ${f.to}`);
      return r.fixes.length ? { ...s, narration: r.text } : s;
    }) };

    // ── 2. Clarification: ask, change nothing ──
    if (plan.intent === "clarify") {
      const question = plan.clarificationQuestion!;
      emit({ type: "action", action: { action: "ask_user", question } });
      recordTurn(memory, { user: message, resolvedRequest: plan.resolvedRequest, intent: "clarify", summary: `Asked for clarification: ${question}`, steps: [], question });
      memory.pendingQuestion = question;
      pushUndo(memory, before);
      await this.repo.save(memory);
      emit({ type: "done" });
      return;
    }

    if (plan.cannotDraw) {
      emit({ type: "notice", message: `I can't draw ${plan.cannotDraw} on the whiteboard yet, so I've explained it in words instead.` });
    }

    // ── 3. Design + layout + compile the visual (degrades gracefully) ──
    const target = plan.targetDiagramId ? memory.diagrams.find((d) => d.id === plan.targetDiagramId) : undefined;
    let visual: VisualOutput | null = null;
    if (plan.needsVisual) {
      emit({ type: "progress", stage: "designing", label: target ? "Updating the diagram" : "Designing the visual" });
      try {
        visual = await this.buildVisual(plan, memory, view, canvas, target, signal, emit);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof NoChangeError) {
          emit({ type: "notice", message: "I couldn't find a meaningful way to apply that change, so the diagram is unchanged. Try describing the change more specifically." });
          emit({ type: "done", topic: memory.topic });
          return;
        }
        console.error("❌ visual pipeline failed:", redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
        if (err instanceof SketchError && !target) {
          emit({ type: "notice", message: `${err.message} The explanation is ready; the canvas is unchanged.` });
          err = null;
        }
        if (target && TARGETED_INTENTS.has(plan.intent)) {
          // The narration of an edit describes a change; never claim a change that did not happen.
          // Nothing is recorded, so the user can simply retry.
          emit({ type: "error", ...userMessageFor(err) });
          return;
        }
        if (err) emit({
          type: "notice",
          message:
            err instanceof LLMError && ["quota", "rate_limit", "timeout", "network", "server"].includes(err.kind)
              ? "The explanation is ready, but the AI service was too busy to draw the diagram. Ask again to retry the visual."
              : "The explanation is ready, but I couldn't produce a reliable diagram this time, so I left the canvas unchanged.",
        });
      }
    }
    if (signal.aborted) return;

    // ── 3b. Honesty about what was drawn, and narration that matches it ──
    if (visual) {
      const kind = visual.record.spec.kind;
      const sketch = visual.sketch;
      if (sketch) {
        const subject = sketch.title.toLowerCase();
        emit({
          type: "notice",
          message: {
            local: `Drawn from your reference diagram of the ${subject}, simplified for the whiteboard.`,
            commons: `I don't have a built-in diagram of the ${subject}, so I adapted a freely licensed one from Wikimedia Commons (credit under the drawing). It's simplified.`,
            ai: `I don't have a reference diagram of the ${subject}, so this is a rough AI sketch from simple shapes — check the details against your textbook.`,
          }[sketch.source.kind],
        });
        emit({
          type: "sketch",
          sketchId: sketch.id,
          title: sketch.title,
          status: sketch.status,
          source: sketch.source.kind,
          ...(sketch.source.credit ? { credit: sketch.source.credit } : {}),
          ...(sketch.source.url ? { url: sketch.source.url } : {}),
          canReview: sketch.status === "draft" && sketch.lessonId === memory.lessonId,
        });
      } else if (kind === "labelled_diagram") {
        emit({ type: "notice", message: "This is a simplified textbook schematic of the structure — not an anatomical or realistic drawing." });
      } else if (kind === "map" && HISTORICAL.test(`${message} ${plan.topic}`)) {
        emit({ type: "notice", message: "The map shows today's country borders, not the historical ones." });
      } else if (!["molecule", "atom", "map"].includes(kind) && REALISTIC_REQUEST.test(message)) {
        emit({ type: "notice", message: "This is a simplified schematic to show the structure — not a realistic or anatomical drawing." });
      }
      // The whole diagram as it will stand (an edit only redraws part of it).
      const checked = checkNarration(plan.steps, visual.record.compiled);
      if (checked.dropped.length) {
        console.log(`[AI] narration trimmed to match the diagram: ${checked.dropped.length} sentence(s)`);
        plan = { ...plan, steps: plan.steps.map((s, i) => ({ ...s, narration: checked.steps[i].narration })) };
      }
    }

    // ── 4. Stream: narration and drawing interleaved by step ──
    emit({ type: "progress", stage: "drawing", label: visual ? "Drawing" : "Writing the explanation" });
    const stream: DSLAction[] = [];
    if (visual) {
      stream.push(...visual.deletes, ...visual.updates);
      if (visual.isNew) stream.push({ action: "pan_to", x: visual.center.x, y: visual.center.y });
    }
    plan.steps.forEach((step, i) => {
      stream.push({ action: "narrate", title: step.title, text: step.narration });
      const creates = visual?.byStep.get(i + 1) ?? [];
      stream.push(...creates);
      if (creates.length && i < plan.steps.length - 1) stream.push({ action: "wait", durationMs: STEP_PAUSE_MS });
    });
    // Elements tagged with steps beyond the plan (shouldn't happen after validation) still get drawn.
    if (visual) for (const [s, creates] of visual.byStep) if (s > plan.steps.length) stream.push(...creates);
    if (visual?.changes.length) {
      stream.push({ action: "narrate", title: "What changed", text: visual.changes.join(" ") });
    }
    if (plan.caveats?.length) {
      stream.push({ action: "narrate", title: "Worth double-checking", text: plan.caveats.join(" ") });
    }
    if (plan.intent === "answer_only" && plan.targetDiagramId && plan.highlight?.length) {
      for (const node of plan.highlight) {
        stream.push({ action: "highlight_element", elementId: elementId(plan.targetDiagramId, node), color: PALETTE.warning.stroke });
      }
    }
    if (visual) stream.push({ action: "focus_diagram", diagramId: visual.record.id });

    const gate = gateActions(stream, canvas.elements);
    if (gate.warnings.length) console.warn(`🚧 gate: ${gate.warnings.join(" | ")}`);

    // ── 5. Persist BEFORE streaming so a disconnect can't desync memory ──
    if (visual) {
      const existing = memory.diagrams.findIndex((d) => d.id === visual!.record.id);
      if (existing >= 0) memory.diagrams[existing] = visual.record;
      else memory.diagrams.push(visual.record);
      memory.activeDiagramId = visual.record.id;
      addExample(memory, visual.record.spec.example);
    }
    if (plan.intent === "new_topic" || !memory.topic) memory.topic = plan.topic;
    addConcepts(memory, plan.concepts ?? []);
    memory.pendingQuestion = null;
    recordTurn(memory, {
      user: message,
      resolvedRequest: plan.resolvedRequest,
      intent: plan.intent,
      summary: plan.summary || plan.resolvedRequest,
      steps: plan.steps,
      diagramId: visual?.record.id ?? plan.targetDiagramId ?? undefined,
    });
    pushUndo(memory, before);
    await this.repo.save(memory);

    for (const action of gate.actions) {
      if (signal.aborted) return;
      emit({ type: "action", action });
    }
    emit({ type: "done", summary: plan.summary, topic: memory.topic });
  }

  private async buildVisual(
    plan: Plan,
    memory: LessonMemory,
    view: ReturnType<typeof viewCanvas>,
    canvas: CanvasState,
    target: DiagramRecord | undefined,
    signal: AbortSignal,
    emit: Emit
  ): Promise<VisualOutput> {
    const editing = Boolean(target && TARGETED_INTENTS.has(plan.intent));
    const stepCount = Math.max(1, plan.steps.length);
    let spec: DiagramSpec;
    let meta: AIResponseMeta | null;
    try {
      ({ spec, meta } = await this.visual.design({ plan, memory, target: editing ? target : undefined, signal }));
    } catch (err) {
      // The worked example doesn't depend on the designer: still put it on the board.
      if (signal.aborted || editing || !plan.workedExample) throw err;
      console.warn("🧮 designer failed → drawing the worked example on its own:", redact(err instanceof Error ? err.message : String(err)).slice(0, 160));
      emit({ type: "notice", message: "I couldn't draw the main diagram this time, so the board shows the worked example on its own." });
      spec = DiagramSpecSchema.parse({ title: plan.workedExample.title ?? `Worked example: ${plan.topic}`.slice(0, 70), kind: "flowchart" });
      meta = null;
    }
    if (meta) emitMeta(emit, meta);
    // No built-in schematic for this structure: find a reference diagram or sketch one.
    let sketch: SketchRecord | null = null;
    const prepare = async () => {
      const prepared = await this.sketcher.prepare(spec, { lessonId: memory.lessonId, signal, emit });
      sketch = prepared.sketch;
      if (sketch) spec = validateSpec(prepared.spec, stepCount).spec;
    };
    await prepare();
    let changes: string[] = [];
    if (editing && (plan.intent === "remove_from_visual" || isRemovalRequest(plan.resolvedRequest))) {
      const restricted = restrictToExisting(target!.spec, spec);
      if (restricted.stripped.length || (restricted.spec.annotations?.length ?? 0) !== (spec.annotations?.length ?? 0)) {
        console.warn(`🛡️  removal request tried to add ${restricted.stripped.map((l) => `"${l}"`).join(", ")} → stripped`);
        spec = validateSpec(restricted.spec, Math.max(1, plan.steps.length)).spec;
      }
    }
    if (editing) {
      changes = describeSpecChanges(target!.spec, spec);
      if (changes.length === 0) {
        // The model "revised" the diagram without changing it — ask once more, explicitly.
        console.warn("🔁 edit produced an identical diagram → retrying with feedback");
        ({ spec, meta } = await this.visual.design({
          plan, memory, target, signal,
          feedback: `Your revision is identical to the existing diagram. Actually apply this change: ${plan.resolvedRequest}`,
        }));
        emitMeta(emit, meta!);
        await prepare();
        changes = describeSpecChanges(target!.spec, spec);
        if (changes.length === 0) throw new NoChangeError();
      }
    }

    // The worked example: from the plan (the same numbers as the notes); an edit keeps the existing one
    // unless the plan solves a new example or the student asked to remove it.
    const dropExample = plan.intent === "remove_from_visual" && /\b(example|worked|solution|steps)\b/i.test(plan.resolvedRequest);
    const worked = plan.workedExample ?? (dropExample ? undefined : spec.worked ?? (editing ? target!.spec.worked : undefined));
    if (worked || spec.worked) {
      const checked = validateSpec({ ...spec, worked, example: spec.example ?? worked?.problem.slice(0, 160) }, stepCount);
      for (const issue of checked.issues.filter((i) => i.startsWith("arithmetic"))) console.log(`[AI] ${issue}`);
      spec = checked.spec;
    }
    const placed = layoutDiagram(spec, stepCount);
    const diagramId = editing ? target!.id : allocateDiagramId(memory, view);
    const others = canvas.elements.filter((e) => e.diagramId !== diagramId);
    const origin = chooseOrigin({ w: placed.width, h: placed.height }, others, editing ? { x: target!.bbox.x, y: target!.bbox.y } : undefined);
    const compiled = compileDiagram(placed, diagramId, origin);

    let deletes: DSLAction[] = [];
    let updates: DSLAction[] = [];
    let byStep = compiled.byStep;
    if (editing) {
      const existingIds = new Set((view.byDiagram.get(diagramId) ?? []).map((e) => e.id));
      const untouched = diagramUntouched(target!, view) && origin.x === target!.bbox.x && origin.y === target!.bbox.y;
      const diff = diffDiagram(target!.compiled, compiled.creates, existingIds, untouched);
      deletes = diff.deletes;
      updates = diff.updates;
      // Elements the user had drawn on top of the diagram's id space (rare) or leftovers not in memory.
      for (const id of existingIds) {
        if (!compiled.creates.some((a) => a.id === id) && !deletes.some((d) => d.action === "delete_element" && d.elementId === id)) {
          deletes.push({ action: "delete_element", elementId: id });
        }
      }
      byStep = new Map([...compiled.byStep].map(([s, list]) => [s, list.filter((a) => !diff.keep.has(a.id))]));
    }

    const now = (memory.turns.at(-1)?.id ?? 0) + 1;
    return {
      isNew: !editing,
      sketch,
      changes,
      deletes,
      updates,
      byStep,
      center: { x: origin.x + placed.width / 2, y: origin.y + placed.height / 2 },
      record: {
        id: diagramId,
        title: spec.title,
        kind: spec.kind,
        spec,
        compiled: compiled.creates as CreateAction[],
        bbox: compiled.bbox,
        stepTitles: plan.steps.map((s) => s.title),
        createdTurn: editing ? target!.createdTurn : now,
        updatedTurn: now,
        status: "on_canvas",
      },
    };
  }
}

/**
 * The worked example is solved step by step on the board, so the notes walk through it too: when
 * the planner squeezed the example into one or two explanation steps, each worked step gets its own
 * narration step (its working, in words), and the cards are revealed one per step.
 */
export function narrateWorkedSteps(plan: Plan): Plan {
  const w = plan.workedExample;
  if (!w || w.steps.length < 3) return plan;
  const distinct = new Set(w.steps.map((s) => s.step ?? 0));
  if (distinct.size >= Math.min(w.steps.length, 3)) {
    // Already one card per explanation step. If a step's narration only describes the method, add
    // the example's working to it, so the notes solve the example alongside the board.
    const numbers = (s: string) => new Set(s.match(/\d+(\.\d+)?/g) ?? []);
    let added = 0;
    const steps = plan.steps.map((step, i) => {
      const cards = w.steps.filter((s) => s.step === i + 1 && s.lines.length);
      if (!cards.length) return step;
      const said = numbers(step.narration);
      const working = cards.map((c) => `${c.title}: ${c.lines.map((l) => l.replace(/[.;:]\s*$/, "")).join("; ")}`).join(". ");
      if ([...numbers(working)].some((n) => said.has(n) && n.length > 1)) return step;
      added++;
      return { ...step, narration: `${step.narration} In the example — ${working}.` };
    });
    if (added) console.log(`🧮 example working added to ${added} narration step(s)`);
    return added ? { ...plan, steps } : plan;
  }
  const MAX_STEPS = 12;
  const concept = plan.steps.slice(0, Math.max(1, Math.min(plan.steps.length, MAX_STEPS - w.steps.length)));
  const extra = w.steps.map((s, i) => {
    const working = s.lines.map((l) => l.replace(/[.;:]\s*$/, "")).join("; ");
    const last = i === w.steps.length - 1 && w.answer ? ` Answer: ${w.answer}` : "";
    return { title: s.title, narration: `${working || s.title}.${last}`.slice(0, 700) };
  });
  console.log(`🧮 worked example narrated step by step (${extra.length} steps)`);
  return {
    ...plan,
    steps: [...concept, ...extra],
    workedExample: { ...w, steps: w.steps.map((s, i) => ({ ...s, step: concept.length + i + 1 })) },
  };
}

class NoChangeError extends Error {
  constructor() {
    super("Edit produced no change");
  }
}

interface VisualOutput {
  isNew: boolean;
  /** The sketch drawn when no built-in template fits (reference SVG or AI sketch). */
  sketch: SketchRecord | null;
  /** Deterministic, guaranteed-true description of an edit (empty for new diagrams). */
  changes: string[];
  deletes: DSLAction[];
  /** In-place label / colour changes to shapes that otherwise stay as they are. */
  updates: DSLAction[];
  byStep: Map<number, CreateAction[]>;
  center: { x: number; y: number };
  record: DiagramRecord;
}
