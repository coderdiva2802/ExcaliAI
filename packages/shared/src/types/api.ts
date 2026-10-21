// ─────────────────────────────────────────────────────────
// API Request / Response Types
// ─────────────────────────────────────────────────────────

import type { CanvasState } from "./canvas";
import type { DSLAction } from "./actions";

// ── Lesson endpoints ───────────────────────────────────

export interface StartLessonRequest {
  prompt: string;
  canvasState: CanvasState;
}

export interface SendMessageRequest {
  prompt: string;
  canvasState: CanvasState;
}

// ── SSE event types ────────────────────────────────────

/** High-level pipeline stages surfaced to the user (never chain-of-thought). */
export type ProgressStage =
  | "understanding"
  | "planning"
  | "designing"
  | "validating"
  | "drawing";

/** Discriminated union for SSE events sent from the server. */
export type SSEEvent =
  | SSELessonEvent
  | SSEProgressEvent
  | SSEActionEvent
  | SSENarrateEvent
  | SSEAskUserEvent
  | SSENoticeEvent
  | SSESketchEvent
  | SSEErrorEvent
  | SSEMetaEvent
  | SSEDoneEvent;

/** First event of every stream: the lesson this turn belongs to. */
export interface SSELessonEvent {
  type: "lesson";
  lessonId: string;
}

export interface SSEProgressEvent {
  type: "progress";
  stage: ProgressStage;
  label: string;
}

export interface SSEActionEvent {
  type: "action";
  action: DSLAction;
}

export interface SSENarrateEvent {
  type: "narrate";
  text: string;
  title?: string;
}

export interface SSEAskUserEvent {
  type: "ask_user";
  question: string;
}

/** Non-fatal information, e.g. "the explanation is ready but the diagram failed". */
export interface SSENoticeEvent {
  type: "notice";
  message: string;
}

/**
 * The diagram is a sketch (no built-in template fitted): where it came from, and
 * whether this lesson may approve it for reuse by everyone or reject it.
 */
export interface SSESketchEvent {
  type: "sketch";
  sketchId: string;
  title: string;
  status: "draft" | "approved";
  source: "local" | "commons" | "ai";
  /** Attribution line (required by CC BY / CC BY-SA sources). */
  credit?: string;
  /** Source page of a reference diagram. */
  url?: string;
  canReview: boolean;
}

export interface SSEErrorEvent {
  type: "error";
  /** User-facing message (never a raw stack trace or provider payload). */
  message: string;
  retryable: boolean;
}

/**
 * Debug-only: which provider/model served a pipeline task. Emitted only when
 * the server enables AI_EXPOSE_META (default: development). Never contains secrets.
 */
export interface SSEMetaEvent {
  type: "meta";
  task: "planner" | "designer";
  provider: string;
  model: string;
  ms: number;
}

export interface SSEDoneEvent {
  type: "done";
  summary?: string;
  /** The lesson topic as resolved by the planner. */
  topic?: string;
}
