// ─────────────────────────────────────────────────────────
// Agent / LLM-layer self-test with fake providers (no network).
//
//   npm run test:agents -w apps/server
//
// Covers: provider fallback, quota circuit breaking, timeouts,
// cancellation, malformed / empty / fenced model output,
// planner grounding (hallucinated targets, ambiguity) and a
// full TutorAgent turn including a no-op edit.
// ─────────────────────────────────────────────────────────

import type { CanvasState, SSEEvent } from "@excaliai/shared";
import { z } from "zod";
import { AIGateway } from "../llm/gateway.js";
import type { AIProvider, AIRequest, ProviderId } from "../llm/types.js";
import { LLMError, classifyError } from "../llm/errors.js";
import { extractJSON } from "../llm/json.js";
import { providerHealth } from "../llm/health.js";
import { createOpenRouterProvider, isFreeModelId } from "../llm/providers/openrouter.js";
import { ground, type Plan } from "./PlannerAgent.js";
import { newMemory, undoLastTurn, type LessonMemory } from "./memory.js";
import { TutorAgent, narrateWorkedSteps } from "./TutorAgent.js";
import { checkNarration } from "./narrationCheck.js";
import { VisualPlannerAgent } from "./VisualPlannerAgent.js";
import { DiagramSpecSchema } from "../diagram/spec.js";
import type { LessonRepository } from "../storage/lessonRepository.js";

let failures = 0;
const check = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

let seq = 0;
class FakeProvider implements AIProvider {
  calls = 0;
  readonly name: string;
  readonly model: string;
  constructor(readonly provider: ProviderId, private behave: (req: AIRequest, call: number) => Promise<string>) {
    this.model = `fake-${++seq}`;
    this.name = `${provider}:${this.model}`;
  }
  complete(req: AIRequest) {
    return this.behave(req, ++this.calls);
  }
}
const ask = { system: "s", messages: [{ role: "user" as const, content: "u" }] };
const quotaError = () => Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota. limit: 0"}}'), { status: 429 });
const gw = (routes: AIProvider[], timeout = 2000, attempts = 2) => new AIGateway("planner", routes, timeout, attempts);

// ── Resilience: fallback, health, timeouts, cancellation ──
{
  const mistral = new FakeProvider("mistral", async () => { throw quotaError(); });
  const openrouter = new FakeProvider("openrouter", async () => "hello");
  const g = gw([mistral, openrouter]);
  const r1 = await g.generateText(ask);
  check(r1.meta.provider === "openrouter", "Mistral quota exhausted → falls back to OpenRouter");
  await g.generateText(ask);
  check(mistral.calls === 1, "quota puts Mistral in cool-down (not retried on the next request)");
  check(providerHealth.snapshot().find((h) => h.route === mistral.name)?.status === "quota_exhausted", "health registry reports quota_exhausted");
}
{
  const openrouter = new FakeProvider("openrouter", async () => {
    throw Object.assign(new Error("openrouter 429: Rate limit exceeded: free-models-per-day"), { status: 429 });
  });
  const gemini = new FakeProvider("gemini", async () => "from gemini");
  const r = await gw([openrouter, gemini]).generateText(ask);
  check(r.meta.provider === "gemini", "OpenRouter daily cap → falls back to the next configured provider");
}
{
  const flaky = new FakeProvider("groq", async (_r, n) => {
    if (n === 1) throw Object.assign(new Error("groq 503: overloaded"), { status: 503 });
    return "ok";
  });
  await gw([flaky]).generateText(ask);
  check(flaky.calls === 2, "retries a transient 5xx once on the same provider");
}
{
  const badKey = new FakeProvider("mistral", async () => { throw Object.assign(new Error("mistral 401: Unauthorized"), { status: 401 }); });
  const backup = new FakeProvider("openrouter", async () => "ok");
  const r = await gw([badKey, backup]).generateText(ask);
  check(badKey.calls === 1 && r.meta.provider === "openrouter", "invalid API key is not retried; next provider is used");
}
{
  const hang = new FakeProvider("mistral", (r) => new Promise((_, reject) => r.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
  const backup = new FakeProvider("openrouter", async () => "ok");
  const t0 = Date.now();
  const r = await gw([hang, backup], 300, 1).generateText(ask);
  check(r.meta.provider === "openrouter" && Date.now() - t0 < 2000, "a hanging provider times out and falls back");
}
{
  const hang = new FakeProvider("mistral", (r) => new Promise((_, reject) => r.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const err = await gw([hang], 10_000).generateText({ ...ask, signal: ac.signal }).catch((e: unknown) => e);
  check(err instanceof LLMError && err.kind === "aborted", "client cancellation aborts immediately without fallback");
}
{
  const err = await gw([new FakeProvider("gemini", async () => { throw quotaError(); })], 1000).generateText(ask).catch((e: unknown) => e);
  check(err instanceof LLMError && err.kind === "quota", "all providers failing surfaces a classified error");
}

{
  // An invalid OpenRouter key must not cost one failed call per configured OpenRouter model.
  const orA = new FakeProvider("openrouter", async () => { throw Object.assign(new Error("openrouter 401: invalid key"), { status: 401 }); });
  const orB = new FakeProvider("openrouter", async () => "should not be called");
  for (const r of [orA, orB]) providerHealth.register(r.name);
  const gem = new FakeProvider("gemini", async () => "gemini ok");
  const r = await gw([orA, orB, gem]).generateText(ask);
  check(orB.calls === 0 && r.meta.provider === "gemini", "account-level failure (bad key) cools down ALL routes of that provider");
}

// ── Structured output: invalid output never leaves the gateway ──
{
  const schema = z.object({ title: z.string(), count: z.number() });
  const sloppy = new FakeProvider("mistral", async (r, n) =>
    n === 1 ? "Sure! Here you go: {title: oops" : r.messages.some((m) => m.content.includes("rejected")) ? '{"title":"fixed","count":2}' : "{}"
  );
  const r = await gw([sloppy]).generateStructured(ask, schema);
  check(r.data.title === "fixed" && sloppy.calls === 2, "malformed JSON gets one correction attempt on the same model");

  const wrong = new FakeProvider("mistral", async () => '{"title": 5}');
  const right = new FakeProvider("openrouter", async () => '```json\n{"title":"ok","count":1}\n```');
  const r2 = await gw([wrong, right]).generateStructured(ask, schema);
  check(wrong.calls === 2 && r2.meta.provider === "openrouter" && r2.data.count === 1, "schema-invalid output → correction → falls back to next provider");

  const never = new FakeProvider("groq", async () => "not json at all");
  const err = await gw([never]).generateStructured(ask, schema).catch((e: unknown) => e);
  check(err instanceof LLMError && err.kind === "invalid_output", "unusable output from every provider is rejected, never returned");

  let calls = 0;
  const counted = new FakeProvider("mistral", async () => { calls++; return '{"title":"c","count":3}'; });
  const g = gw([counted]);
  await g.generateStructured({ ...ask, messages: [{ role: "user", content: "cache me" }] }, schema, { cache: true });
  await g.generateStructured({ ...ask, messages: [{ role: "user", content: "cache me" }] }, schema, { cache: true });
  check(calls === 1, "identical cacheable structured requests are served from cache (no duplicate spend)");
}

// ── Free-tier protection ───────────────────────────────
check(isFreeModelId("nvidia/nemotron-3-super-120b-a12b:free") && !isFreeModelId("openai/gpt-4o"), "only :free OpenRouter model ids are treated as free");
check(createOpenRouterProvider("openai/gpt-4o") === null, "a paid OpenRouter model is refused at construction");
{
  const e402 = classifyError(Object.assign(new Error("openrouter 402: insufficient credits"), { status: 402 }), "openrouter");
  check(e402.kind === "quota" && !e402.transient, "402 (payment required) is treated as quota and never retried");
  const daily = classifyError(Object.assign(new Error("Rate limit exceeded: free-models-per-day"), { status: 429 }), "openrouter");
  check(daily.kind === "quota" && (daily.retryAfterMs ?? 0) >= 3_600_000, "OpenRouter daily free cap → long cool-down, not a retry loop");
  const perMin = classifyError(Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 4000 }), "mistral");
  check(perMin.kind === "rate_limit" && perMin.retryAfterMs === 4000, "per-minute limit with Retry-After is a short, retryable rate limit");
}

// ── Malformed output ───────────────────────────────────
check((extractJSON('```json\n{"a":1}\n```') as { a: number }).a === 1, "extracts JSON from code fences");
check((extractJSON('<think>hmm {"no":1}</think>Sure! {"a":{"b":"}"}} trailing') as { a: { b: string } }).a.b === "}", "skips reasoning blocks and handles braces inside strings");
check((extractJSON('{"a":[1,2,],}') as { a: number[] }).a.length === 2, "repairs trailing commas");
for (const bad of ["", "no json here", '{"a": [1, 2'])
  check((() => { try { extractJSON(bad); return false; } catch (e) { return e instanceof LLMError && e.kind === "invalid_output"; } })(), `rejects unusable output: ${JSON.stringify(bad)}`);

// ── Planner grounding ──────────────────────────────────
function memoryWith(ids: string[]): LessonMemory {
  const m = newMemory("groundtest01");
  m.topic = "binary search";
  for (const id of ids) {
    m.diagrams.push({
      id, title: `Diagram ${id}`, kind: "flowchart", compiled: [], bbox: { x: 0, y: 0, w: 1, h: 1 }, stepTitles: [], createdTurn: 1, updatedTurn: 1, status: "on_canvas",
      spec: { title: id, kind: "flowchart", nodes: [{ id: "a", label: "A" }], edges: [] } as never,
    });
  }
  m.activeDiagramId = ids.at(-1) ?? null;
  return m;
}
const basePlan: Plan = { intent: "modify_visual", topic: "", resolvedRequest: "simplify it", targetDiagramId: null, clarificationQuestion: null, needsVisual: true, visualKind: null, steps: [{ title: "t", narration: "n" }], highlight: [], summary: "", concepts: [], caveats: [] };

check(ground({ ...basePlan, targetDiagramId: "d1" }, memoryWith(["d1", "d2"])).targetDiagramId === "d1", "explicit valid target is kept");
check(ground({ ...basePlan }, memoryWith(["d1", "d2"])).targetDiagramId === "d2", "'that diagram' with no explicit target resolves to the active diagram");
const halluc = ground({ ...basePlan, targetDiagramId: "d9" }, memoryWith(["d1", "d2"]));
check(halluc.intent === "clarify" && /Which diagram/.test(halluc.clarificationQuestion ?? ""), "a hallucinated target with several candidates becomes a clarification question");
check(ground({ ...basePlan, targetDiagramId: "d9" }, memoryWith(["d1"])).targetDiagramId === "d1", "a hallucinated target with one diagram resolves to it");
check(ground({ ...basePlan }, memoryWith([])).intent === "follow_up", "an edit with nothing on the canvas becomes a fresh follow-up");
check((ground({ ...basePlan, intent: "answer_only", targetDiagramId: "d1", highlight: ["a", "ghost"] }, memoryWith(["d1"])).highlight ?? []).join() === "a", "highlights are filtered to nodes that exist");

// Regression for the screenshot bug: "Can you draw a number line?" while a timeline is active.
{
  const m = memoryWith(["d1"]);
  m.diagrams[0].kind = "timeline";
  const drawNew = ground({ ...basePlan, intent: "modify_visual", targetDiagramId: "d1", visualKind: "number_line" }, m, "Can you draw a number line?");
  check(drawNew.intent === "follow_up" && drawNew.targetDiagramId === null, "'draw a number line' creates a NEW diagram instead of overwriting the timeline");
  const convert = ground({ ...basePlan, intent: "modify_visual", targetDiagramId: "d1", visualKind: "number_line" }, m, "Convert that diagram into a number line");
  check(convert.intent === "modify_visual" && convert.targetDiagramId === "d1", "an explicit 'convert it' request still edits the existing diagram");
  const honest = ground({ ...basePlan, intent: "new_topic", needsVisual: true, cannotDraw: "a labelled drawing of the human heart" }, m, "draw the heart");
  check(honest.needsVisual === false, "out-of-scope visuals are declined honestly instead of approximated");
}
{
  const groqJson = classifyError(Object.assign(new Error('groq 400: {"error":{"message":"Failed to generate JSON","code":"json_validate_failed"}}'), { status: 400 }), "groq");
  check(groqJson.kind === "invalid_output" && groqJson.transient, "Groq json_validate_failed is a retryable bad answer, not a bad request");
}

// ── Full turn with scripted models ─────────────────────
{
  const store = new Map<string, LessonMemory>();
  const repo: LessonRepository = { load: async (id) => structuredClone(store.get(id) ?? null), save: async (m) => void store.set(m.lessonId, structuredClone(m)) };
  const plans: object[] = [
    { intent: "new_topic", topic: "stacks", resolvedRequest: "Explain stacks", needsVisual: true, visualKind: "stack", steps: [{ title: "LIFO", narration: "Last in, first out." }], summary: "Introduced stacks." },
    { intent: "modify_visual", topic: "stacks", resolvedRequest: "Make the stack diagram simpler", targetDiagramId: "d1", needsVisual: true, steps: [{ title: "Simpler", narration: "Fewer items." }], summary: "Simplified." },
  ];
  const stackSpec = { title: "A stack", kind: "stack", nodes: [{ id: "a", label: "1" }, { id: "b", label: "2" }] };
  const planner = new AIGateway("planner", [new FakeProvider("mistral", async (_r, n) => JSON.stringify(plans[Math.min(n, plans.length) - 1]))], 1000);
  // The designer always returns the same spec → the edit is a no-op and must be reported honestly.
  const designer = new AIGateway("designer", [new FakeProvider("openrouter", async () => "```json\n" + JSON.stringify(stackSpec) + "\n```")], 1000);
  const agent = new TutorAgent(repo, planner, designer);

  const events: SSEEvent[] = [];
  const canvas: CanvasState = { elements: [], viewport: { scrollX: 0, scrollY: 0, zoom: 1 } };
  await agent.runTurn("turntest0001", "Explain stacks", canvas, (e) => events.push(e), new AbortController().signal);
  const creates = events.flatMap((e) => (e.type === "action" && "id" in e.action ? [e.action] : []));
  check(creates.length > 0 && events.at(-1)?.type === "done", `turn 1 drew ${creates.length} validated elements and finished`);

  // Feed the drawn elements back as the client would.
  const drawn: CanvasState = {
    viewport: canvas.viewport,
    elements: creates.map((a) => ({ id: a.id, type: "rectangle", x: (a as { x?: number }).x ?? 0, y: (a as { y?: number }).y ?? 0, width: 10, height: 10, diagramId: a.diagramId })),
  };
  const events2: SSEEvent[] = [];
  await agent.runTurn("turntest0001", "make that simpler", drawn, (e) => events2.push(e), new AbortController().signal);
  const notice = events2.find((e) => e.type === "notice");
  const claimed = events2.some((e) => e.type === "action" && e.action.action === "narrate");
  check(notice && !claimed, "a no-op edit is reported honestly (notice, no narrated claims)");
  check(store.get("turntest0001")?.turns.length === 1, "a no-op edit is not recorded as a turn");
}

// ── Undo the last AI turn ──────────────────────────────
{
  const store = new Map<string, LessonMemory>();
  const repo: LessonRepository = { load: async (id) => structuredClone(store.get(id) ?? null), save: async (m) => void store.set(m.lessonId, structuredClone(m)) };
  const plans = [
    { intent: "new_topic", topic: "stacks", resolvedRequest: "Explain stacks", needsVisual: true, visualKind: "stack", steps: [{ title: "LIFO", narration: "Last in, first out." }], summary: "Stacks." },
    { intent: "extend_visual", topic: "stacks", resolvedRequest: "Add a third item", targetDiagramId: "d1", needsVisual: true, steps: [{ title: "Push", narration: "Push 3." }], summary: "Pushed 3." },
    { intent: "follow_up", topic: "stacks", resolvedRequest: "Compare with a queue", needsVisual: true, visualKind: "queue", steps: [{ title: "FIFO", narration: "First in, first out." }], summary: "Queues." },
  ];
  const specs = [
    { title: "A stack", kind: "stack", nodes: [{ id: "a", label: "1" }, { id: "b", label: "2" }] },
    { title: "A stack", kind: "stack", nodes: [{ id: "a", label: "1" }, { id: "b", label: "2" }, { id: "c", label: "3", step: 1 }] },
    { title: "A queue", kind: "queue", nodes: [{ id: "x", label: "A" }, { id: "y", label: "B" }] },
  ];
  // Answer by request content (not call count): internal retries must not shift which reply goes where.
  const pick = (r: AIRequest) => {
    const text = r.messages.map((m) => m.content).join(" ");
    const last = text.slice(text.lastIndexOf("<user_message>") + 1 || text.lastIndexOf("REQUEST:"));
    return /queue/i.test(last) ? 2 : /third/i.test(last) ? 1 : 0;
  };
  const planner = new AIGateway("planner", [new FakeProvider("mistral", async (r) => JSON.stringify(plans[pick(r)]))], 1000);
  const designer = new AIGateway("designer", [new FakeProvider("openrouter", async (r) => JSON.stringify(specs[pick(r)]))], 1000);
  const agent = new TutorAgent(repo, planner, designer);

  // A minimal client: applies creates/deletes to an element list it sends back each turn.
  let elements: CanvasState["elements"] = [];
  const apply = (actions: Array<{ action: string; id?: string; elementId?: string; diagramId?: string; x?: number; y?: number }>) => {
    for (const a of actions) {
      if (a.action === "delete_element") elements = elements.filter((e) => e.id !== a.elementId);
      else if (a.id && a.action.startsWith("create_")) elements = [...elements.filter((e) => e.id !== a.id), { id: a.id, type: "rectangle", x: a.x ?? 0, y: a.y ?? 0, width: 10, height: 10, diagramId: a.diagramId }];
    }
  };
  const turn = async (msg: string) => {
    const evs: SSEEvent[] = [];
    await agent.runTurn("undotest0001", msg, { elements, viewport: { scrollX: 0, scrollY: 0, zoom: 1 } }, (e) => evs.push(e), new AbortController().signal);
    apply(evs.flatMap((e) => (e.type === "action" ? [e.action as never] : [])));
  };
  await turn("Explain stacks");
  const afterTurn1 = elements.map((e) => e.id).sort().join();
  await turn("Add a third item");
  await turn("Compare with a queue");
  const m3 = store.get("undotest0001")!;
  check(m3.turns.length === 3 && m3.diagrams.length === 2 && (m3.history?.length ?? 0) === 3, "three turns recorded with three undo snapshots");
  const last = m3.history!.at(-1)!;
  check(last.diagrams.length === 1 && "ref" in last.diagrams[0], "a diagram the turn didn't touch is stored as a reference, not copied");

  const u1 = undoLastTurn(structuredClone(m3))!;
  check(u1.undone === "Compare with a queue" && u1.memory.diagrams.length === 1 && u1.memory.turns.length === 2, "undo #1 removes the queue turn and its diagram");
  check(u1.actions.every((a) => a.action !== "delete_element" || a.elementId.startsWith("d2__")), "undo #1 only deletes the queue's elements");
  apply(u1.actions as never);
  store.set("undotest0001", u1.memory);

  const u2 = undoLastTurn(structuredClone(u1.memory))!;
  check(u2.memory.diagrams[0].spec.nodes.length === 2 && u2.undone === "Add a third item", "undo #2 restores the stack as it was before the edit");
  apply(u2.actions as never);
  check(elements.map((e) => e.id).sort().join() === afterTurn1, "after two undos the canvas matches what turn 1 drew");

  const u3 = undoLastTurn(structuredClone(u2.memory))!;
  apply(u3.actions as never);
  check(u3.memory.turns.length === 0 && u3.memory.diagrams.length === 0 && elements.length === 0, "undo #3 empties the lesson and the board");
  check(undoLastTurn(u3.memory) === null, "nothing left to undo → null");
  console.log("✓ undo last AI turn");
}

// ── The designer must return the science kind the planner chose ──
{
  // Regression (live): asked for a free-body diagram, a designer imitated it with plain geometry segments.
  const imitation = { title: "FBD", kind: "geometry", geometry: { points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 1, y: 0 }], segments: [{ from: "a", to: "b", label: "50 N" }] } };
  const proper = { title: "FBD", kind: "vectors", vectors: { mode: "free_body", unit: "N", vectors: [{ label: "Pull", magnitude: 50, direction: "right" }, { label: "Weight", magnitude: 98, direction: "down" }] } };
  const replies = [imitation, proper];
  const prompts: string[] = [];
  const stub = {
    generateStructured: async (req: { messages: Array<{ content: string }> }) => {
      prompts.push(req.messages.at(-1)!.content);
      return { data: DiagramSpecSchema.parse(replies.shift()), meta: { task: "designer", provider: "demo", model: "stub", ms: 0 } };
    },
  } as unknown as ConstructorParameters<typeof VisualPlannerAgent>[0];
  const plan = { intent: "new_topic", topic: "forces", resolvedRequest: "free body diagram", visualKind: "vectors", needsVisual: true, steps: [{ title: "Forces", narration: "Two forces act." }] } as unknown as Plan;
  const result = await new VisualPlannerAgent(stub).design({ plan, memory: newMemory("kindguard001") });
  check(result.spec.kind === "vectors", `designer is re-asked for the planned kind (got ${result.spec.kind})`);
  check(prompts.length === 2 && prompts[1].includes('needs kind "vectors"'), "the repair round names the required kind");
  // If the designer still can't produce it, the usable first answer is kept rather than failing.
  replies.push(imitation, imitation);
  const kept = await new VisualPlannerAgent(stub).design({ plan, memory: newMemory("kindguard002") });
  check(kept.spec.kind === "geometry", "a usable answer is kept when the right kind never comes");
  console.log("✓ designer kind guard");
}

// ── Narration must match what was drawn ──
{
  type C = Parameters<typeof checkNarration>[1];
  // Regression (live): a French Revolution timeline narration claimed arrows and a "Reign of Terror" period that weren't drawn.
  const timeline: C = [
    { action: "create_text", id: "d1__t", diagramId: "d1", text: "French Revolution", x: 0, y: 0 },
    { action: "create_rectangle", id: "d1__c1", diagramId: "d1", x: 0, y: 0, width: 10, height: 10, label: "Storming of the Bastille\n14 Jul 1789" },
    { action: "create_rectangle", id: "d1__c2", diagramId: "d1", x: 0, y: 0, width: 10, height: 10, label: "Napoleon's coup\n9 Nov 1799" },
  ];
  const r1 = checkNarration([
    { title: "Start", narration: "The revolution began when Parisians stormed the Bastille in 1789. The arrows show how each event led to the next." },
    { title: "Terror", narration: "Radicals took control in 1793. The highlighted Reign of Terror period shows the years of mass executions." },
    { title: "End", narration: "Napoleon seized power in 1799, ending the revolution. Notice the Bastille card on the timeline." },
  ], timeline);
  check(r1.steps[0].narration === "The revolution began when Parisians stormed the Bastille in 1789.", `arrow claim removed (got: ${r1.steps[0].narration})`);
  check(r1.steps[1].narration === "Radicals took control in 1793.", `claim about an undrawn period removed (got: ${r1.steps[1].narration})`);
  check(r1.steps[2].narration.includes("Notice the Bastille card"), "a visual reference to something that IS drawn is kept");
  check(r1.dropped.length === 2, `exactly the 2 false claims are dropped (got ${r1.dropped.length})`);

  // Numbers the code computed beat numbers the planner wrote.
  const circuit: C = [
    { action: "create_text", id: "d2__v", diagramId: "d2", text: "6 V", x: 0, y: 0 },
    { action: "create_text", id: "d2__l1", diagramId: "d2", text: "12 Ω\n4 V, 0.333 A", x: 0, y: 0 },
    { action: "create_text", id: "d2__calc", diagramId: "d2", text: "Current I = V ÷ R = 6 V ÷ 6 Ω = 1 A", x: 0, y: 0 },
  ];
  const r2 = checkNarration([{ title: "Current", narration: "The total current is 1 A. Each bulb gets 3 V. If the voltage doubled to 12 V, the current would be 2 A." }], circuit);
  check(r2.steps[0].narration === "The total current is 1 A. If the voltage doubled to 12 V, the current would be 2 A.", `wrong computed value removed, hypotheticals kept (got: ${r2.steps[0].narration})`);
  const r3 = checkNarration([{ title: "Arrows", narration: "The arrows show the flow." }], timeline);
  check(r3.steps[0].narration === "Arrows.", "a step whose only sentence is false falls back to its title");
  console.log("✓ narration ↔ diagram consistency");
}

// ── Worked examples reach the canvas ──
{
  const workedExample = {
    title: "Example: 3 + 4 × 2",
    problem: "Evaluate 3 + 4 × 2 using the order of operations.",
    steps: [
      { title: "Multiply first", lines: ["4 × 2 = 9"], step: 2 },
      { title: "Then add", lines: ["3 + 8 = 11"], step: 3 },
    ],
    answer: "3 + 4 × 2 = 11",
  };
  const base = {
    intent: "answer_only", topic: "order of operations", resolvedRequest: "Solve 3 + 4 × 2 step by step", needsVisual: false, visualKind: null,
    steps: Array.from({ length: 9 }, (_, i) => ({ title: `Step ${i + 1}`, narration: i === 1 ? "First, 4 × 2 = 9." : `Narration ${i + 1}.` })),
  };
  const g = ground({ ...base, workedExample } as unknown as Plan, newMemory("worked00001"));
  check(g.needsVisual && g.intent === "new_topic", "a worked example always gets a visual (answer_only → new diagram)");
  check(g.steps.length === 8, "up to 8 explanation steps with a worked example");
  check(ground({ ...base, intent: "new_topic" } as unknown as Plan, newMemory("worked00002")).steps.length === 5, "5 steps without one");

  const meta = { task: "planner", provider: "demo", model: "stub", ms: 0 };
  const plannerStub = (plan: object) => ({ isDemo: false, generateStructured: async (_r: unknown, schema: z.ZodTypeAny) => ({ data: schema.parse(plan), meta }) }) as unknown as AIGateway;
  const flowchart = { title: "Order of operations", kind: "flowchart", nodes: [{ id: "p", label: "Brackets" }, { id: "m", label: "× and ÷" }, { id: "a", label: "+ and −" }], edges: [{ from: "p", to: "m" }, { from: "m", to: "a" }] };
  const designer = (fail: boolean) => ({ isDemo: false, generateStructured: async (_r: unknown, schema: z.ZodTypeAny) => {
    if (fail) throw new LLMError("invalid_output", "stub designer failed");
    return { data: schema.parse(flowchart), meta: { ...meta, task: "designer" } };
  } }) as unknown as AIGateway;
  const plan = { ...base, intent: "new_topic", needsVisual: true, visualKind: "flowchart", steps: base.steps.slice(0, 3), workedExample, summary: "", concepts: [] };
  const repo: LessonRepository = { load: async () => null, save: async () => {} };
  const run = async (fail: boolean) => {
    const events: SSEEvent[] = [];
    await new TutorAgent(repo, plannerStub(plan), designer(fail)).runTurn(`workedrun${fail ? 1 : 0}0`, "Solve 3 + 4 × 2 step by step", { elements: [], viewport: { scrollX: 0, scrollY: 0, zoom: 1 } } as CanvasState, (e) => events.push(e), new AbortController().signal);
    const actions = events.flatMap((e) => (e.type === "action" ? [e.action] : []));
    const texts = actions.map((a) => ("text" in a ? String(a.text) : "") + ("label" in a ? String(a.label ?? "") : "")).join(" | ");
    return { events, actions, texts };
  };
  const ok = await run(false);
  check(ok.actions.some((a) => "id" in a && String(a.id).includes("x-wk_card1")), "the worked example is drawn on the canvas with the diagram");
  check(ok.texts.includes("4 × 2 = 8") && !ok.texts.includes("4 × 2 = 9"), "arithmetic slip corrected on the canvas");
  check(ok.actions.some((a) => a.action === "narrate" && a.text.includes("4 × 2 = 8")), "…and in the narration");
  const narrateIdx = ok.actions.findIndex((a) => a.action === "narrate" && a.title === "Step 2");
  const cardIdx = ok.actions.findIndex((a) => "id" in a && String(a.id).endsWith("x-wk_card0"));
  check(narrateIdx >= 0 && cardIdx > narrateIdx, "a card is drawn during its own teaching step");
  const failed = await run(true);
  check(failed.actions.some((a) => "id" in a && String(a.id).includes("x-wk_answer")), "if the designer fails, the worked example is still drawn");
  check(failed.events.some((e) => e.type === "notice" && e.message.includes("worked example on its own")), "…with an honest notice");
  // The planner squeezed a 4-step example into one explanation step → each worked step is narrated.
  const squeezed = narrateWorkedSteps({
    steps: [{ title: "Idea", narration: "The idea." }, { title: "Example", narration: "We solve an example." }],
    workedExample: { problem: "p", steps: ["A", "B", "C", "D"].map((t) => ({ title: `Visit ${t}`, lines: [`dist(${t}) = 1 + 1 = 2`], step: 2 })), answer: "all 2" },
  } as unknown as Plan);
  check(squeezed.steps.length === 6 && squeezed.steps[2].title === "Visit A" && squeezed.steps[5].narration.endsWith("Answer: all 2"), "each worked step gets its own narration step");
  check(squeezed.workedExample!.steps.map((s) => s.step).join(",") === "3,4,5,6", "…and its card appears with it");
  const fine = { steps: [1, 2, 3].map((i) => ({ title: `S${i}`, narration: "n" })), workedExample: { problem: "p", steps: [1, 2, 3].map((i) => ({ title: `W${i}`, lines: [], step: i })) } } as unknown as Plan;
  check(narrateWorkedSteps(fine) === fine, "an example already narrated step by step is left as planned");
  const methodOnly = narrateWorkedSteps({
    steps: [{ title: "Init", narration: "Set the start to zero." }, { title: "Relax", narration: "Update neighbours." }, { title: "Repeat", narration: "B is reached in 12 here." }],
    workedExample: { problem: "p", steps: [
      { title: "Initialise", lines: ["dist(A) = 0"], step: 1 },
      { title: "Visit A", lines: ["dist(B) = min(inf, 0 + 12) = 12"], step: 2 },
      { title: "Visit B", lines: ["dist(C) = 12 + 3 = 15"], step: 3 },
    ] },
  } as unknown as Plan);
  check(methodOnly.steps[1].narration === "Update neighbours. In the example — Visit A: dist(B) = min(inf, 0 + 12) = 12.", `method-only narration gets the example's working (got: ${methodOnly.steps[1].narration})`);
  check(methodOnly.steps[2].narration === "B is reached in 12 here.", "narration that already walks through the example is left alone");
  console.log("✓ worked examples on the canvas");
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll agent checks passed.");
