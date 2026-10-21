// ─────────────────────────────────────────────────────────
// Action Engine — executes streamed DSL actions sequentially
// with pacing, producing the "teacher at the whiteboard"
// progressive reveal.  Narration flows through the same queue
// so each explanation step appears exactly when its part of
// the diagram is drawn.
//
// A generation counter makes clear() safe while a loop is
// mid-sleep: stale loops exit instead of running concurrently.
// ─────────────────────────────────────────────────────────

import type { DSLAction } from "@excaliai/shared";

const ELEMENT_DELAY_MS = 70;   // between canvas elements
const NARRATION_DELAY_MS = 450; // after a narration step before drawing it
const DEFAULT_WAIT_MS = 700;

export interface ActionEngineHandlers {
  execute: (action: DSLAction) => void | Promise<void>;
  narrate: (text: string, title?: string) => void;
  ask: (question: string) => void;
  /** Fired when the queue drains (and the stream has finished). */
  idle: () => void;
}

export class ActionEngine {
  private queue: DSLAction[] = [];
  private running = false;
  private generation = 0;
  private paused = false;
  private streamOpen = false;

  constructor(private handlers: ActionEngineHandlers) {}

  /** Mark the start of a server stream; `idle` won't fire until endStream(). */
  beginStream(): void {
    this.streamOpen = true;
  }

  endStream(): void {
    this.streamOpen = false;
    if (!this.running && !this.paused) this.handlers.idle();
  }

  enqueue(action: DSLAction): void {
    this.queue.push(action);
    if (!this.running && !this.paused) void this.run(this.generation);
  }

  /** Resume after the user answered an ask_user question. */
  resume(): void {
    this.paused = false;
    if (!this.running && this.queue.length) void this.run(this.generation);
  }

  /** Drop everything pending and invalidate any in-flight loop. */
  clear(): void {
    this.queue = [];
    this.generation++;
    this.running = false;
    this.paused = false;
    this.streamOpen = false;
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0 || this.streamOpen;
  }

  private async run(gen: number): Promise<void> {
    this.running = true;
    while (this.queue.length && gen === this.generation) {
      const action = this.queue.shift()!;
      try {
        if (action.action === "wait") {
          await sleep(action.durationMs ?? DEFAULT_WAIT_MS);
        } else if (action.action === "narrate") {
          this.handlers.narrate(action.text, action.title);
          await sleep(NARRATION_DELAY_MS);
        } else if (action.action === "ask_user") {
          this.handlers.ask(action.question);
          this.paused = true;
          break;
        } else {
          await this.handlers.execute(action);
          if (gen !== this.generation) return;
          if (this.queue.length) await sleep(elementDelay(this.queue.length));
        }
      } catch (err) {
        console.error("Action execution failed:", err, action);
      }
    }
    if (gen !== this.generation) return; // superseded by clear()
    this.running = false;
    if (!this.paused && !this.queue.length && !this.streamOpen) this.handlers.idle();
  }
}

/**
 * Pacing between elements: the usual "drawing" rhythm for normal diagrams, but large ones
 * (maps, molecules with many atoms) speed up so a 150-element map takes ~2s, not ~10s.
 */
function elementDelay(pending: number): number {
  if (pending <= 30) return ELEMENT_DELAY_MS;
  return Math.max(8, Math.round((ELEMENT_DELAY_MS * 30) / pending));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
