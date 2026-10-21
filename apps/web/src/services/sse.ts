// ─────────────────────────────────────────────────────────
// SSE Service — streams a lesson turn from the server.
//
// • Every incoming action is re-validated with the shared DSL
//   schema before it can reach the canvas (defense in depth).
// • Cancellable via AbortSignal (Stop button / new lesson).
// • A silent connection (no data, no heartbeat) times out.
// • Errors are mapped to user-friendly messages; technical
//   details go to the console only.
// ─────────────────────────────────────────────────────────

import type { CanvasState, DSLAction, SSEEvent, SSESketchEvent } from "@excaliai/shared";
import { safeValidateAction } from "@excaliai/visual-dsl";

const API_BASE = `${(import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "")}/api`;
const IDLE_TIMEOUT_MS = 60_000; // server sends a heartbeat every 15s

export interface StreamCallbacks {
  onLesson: (lessonId: string) => void;
  onProgress: (label: string) => void;
  onAction: (action: DSLAction) => void;
  onNotice: (message: string) => void;
  /** The diagram is a sketch (no built-in template): its source, and whether it can be reviewed. */
  onSketch?: (sketch: Omit<SSESketchEvent, "type">) => void;
  /** Debug-only provider/model metadata (sent only when the server enables it). */
  onMeta?: (meta: { task: string; provider: string; model: string; ms: number }) => void;
  onError: (message: string, retryable: boolean) => void;
  onDone: (topic?: string) => void;
}

export class StreamError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
  }
}

/** Send one turn. Starts a new lesson when lessonId is null. */
export interface UndoResponse {
  actions: DSLAction[];
  /** The user message of the undone turn, or null (e.g. an empty clarification). */
  undone: string | null;
  topic: string;
  canUndo: boolean;
}

/** Keep a draft sketch for everyone, or delete a bad one (only the lesson that created it may). */
export async function reviewSketch(sketchId: string, lessonId: string, action: "approve" | "reject"): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/sketches/${encodeURIComponent(sketchId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
  } catch {
    throw new StreamError("Can't reach the server. Check your connection and try again.", true);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new StreamError(body.error ?? "Couldn't save your review.", response.status >= 500);
  }
}

/** Roll the lesson back one AI turn. The server returns the canvas actions that restore the board. */
export async function undoTurn(lessonId: string): Promise<UndoResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/lesson/${encodeURIComponent(lessonId)}/undo`, { method: "POST" });
  } catch {
    throw new StreamError("Can't reach the server. Check your connection and try again.", true);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<UndoResponse> & { error?: string };
  if (!response.ok) throw new StreamError(body.error ?? "Couldn't undo the last answer.", response.status >= 500);
  // Same rule as streamed actions: only schema-valid actions reach the canvas.
  const actions = (body.actions ?? []).filter((a) => safeValidateAction(a).success);
  return { ...(body as UndoResponse), actions };
}

export async function streamTurn(
  lessonId: string | null,
  prompt: string,
  canvasState: CanvasState,
  callbacks: StreamCallbacks,
  signal: AbortSignal
): Promise<void> {
  const url = lessonId ? `${API_BASE}/lesson/${encodeURIComponent(lessonId)}/message` : `${API_BASE}/lesson`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ prompt, canvasState }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    console.error("Network error:", err);
    throw new StreamError("Can't reach the ExcaliAI server. Check that it's running and try again.");
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    console.error(`Request failed (${response.status}):`, detail);
    let message = "The server couldn't process that request. Please try again.";
    try {
      const parsed = JSON.parse(detail) as { error?: string };
      if (response.status === 400 && parsed.error) message = parsed.error;
    } catch {
      /* not JSON */
    }
    if (response.status === 413) message = "The canvas is too large to send. Try starting a new lesson.";
    if (response.status >= 500) message = "The server hit an error. Please try again.";
    throw new StreamError(message, response.status !== 400);
  }

  await readStream(response.body, callbacks, signal);
}

async function readStream(body: ReadableStream<Uint8Array>, cb: StreamCallbacks, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      void reader.cancel();
    }, IDLE_TIMEOUT_MS);
  };

  const dispatch = (event: SSEEvent) => {
    switch (event.type) {
      case "lesson":
        cb.onLesson(event.lessonId);
        break;
      case "progress":
        cb.onProgress(event.label);
        break;
      case "narrate":
        cb.onAction({ action: "narrate", text: event.text, title: event.title });
        break;
      case "ask_user":
        cb.onAction({ action: "ask_user", question: event.question });
        break;
      case "action": {
        const result = safeValidateAction(event.action);
        if (result.success) cb.onAction(result.data as DSLAction);
        else console.warn("Rejected invalid action from server:", result.error, event.action);
        break;
      }
      case "notice":
        cb.onNotice(event.message);
        break;
      case "sketch": {
        const { type: _type, ...sketch } = event;
        cb.onSketch?.(sketch);
        break;
      }
      case "meta":
        cb.onMeta?.({ task: event.task, provider: event.provider, model: event.model, ms: event.ms });
        break;
      case "error":
        finished = true;
        cb.onError(event.message, event.retryable);
        break;
      case "done":
        finished = true;
        cb.onDone(event.topic);
        break;
    }
  };

  try {
    armIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; tolerate \r\n.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const block of events) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue; // comment / heartbeat
        try {
          dispatch(JSON.parse(data) as SSEEvent);
        } catch (err) {
          console.warn("Malformed SSE event ignored:", data, err);
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    console.error("Stream interrupted:", err);
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (signal.aborted) return;
  if (!finished) {
    throw new StreamError(
      timedOut ? "The tutor stopped responding. Please try again." : "The connection dropped before the lesson finished. Please try again."
    );
  }
}
