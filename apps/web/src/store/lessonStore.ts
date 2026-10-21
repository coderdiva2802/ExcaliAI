// ─────────────────────────────────────────────────────────
// Lesson Store — conversation turns, status and progress.
//
// Ownership:
//   • lessonId / turns  — written by App (stream callbacks), persisted locally
//   • status / progress — written by App only; derived by components
//   • canvas content    — owned by Excalidraw (+ canvasStore overlays)
// The server's LessonMemory is the source of truth for AI context;
// this store only mirrors what the user has seen.
// ─────────────────────────────────────────────────────────

import { create } from "zustand";
import type { LessonStatus, SSESketchEvent } from "@excaliai/shared";

export interface TutorStep {
  title?: string;
  text: string;
}

export interface AIMeta {
  task: string;
  provider: string;
  model: string;
  ms: number;
}

export interface Turn {
  id: string;
  /** Debug-only: which provider/model served each pipeline task. */
  meta?: AIMeta[];
  user: string;
  steps: TutorStep[];
  question?: string;
  notice?: string;
  /** The diagram was sketched (no built-in template); `review` records the user's verdict. */
  sketch?: Omit<SSESketchEvent, "type"> & { review?: "approved" | "rejected" };
  error?: string;
  state: "streaming" | "done" | "error" | "cancelled";
}

interface LessonStoreState {
  lessonId: string | null;
  topic: string;
  status: LessonStatus;
  progress: string | null;
  turns: Turn[];
  currentQuestion: string | null;
  /** Last failure, shown as a toast with an optional retry. */
  error: { message: string; retryable: boolean; prompt?: string } | null;

  beginTurn: (prompt: string) => string;
  setLessonId: (id: string) => void;
  setTopic: (topic: string) => void;
  setProgress: (label: string | null) => void;
  addStep: (step: TutorStep) => void;
  setQuestion: (question: string | null) => void;
  setNotice: (message: string) => void;
  setSketch: (sketch: NonNullable<Turn["sketch"]>) => void;
  setSketchReview: (turnId: string, review: "approved" | "rejected") => void;
  addMeta: (meta: AIMeta) => void;
  finishTurn: (state: Turn["state"], error?: string) => void;
  /** Drop the undone turn (and any failed/cancelled attempts after it) from the notes. */
  removeUndoneTurn: (user: string | null, topic: string) => void;
  setStatus: (status: LessonStatus) => void;
  setError: (error: LessonStoreState["error"]) => void;
  reset: () => void;
}

const STORAGE_KEY = "excaliai.lesson.v2";
const MAX_TURNS = 60;

type Persisted = Pick<LessonStoreState, "lessonId" | "topic" | "turns">;

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      // A turn interrupted by a refresh can't resume — mark it cancelled.
      const turns = (p.turns ?? []).map((t) => (t.state === "streaming" ? { ...t, state: "cancelled" as const } : t));
      return { lessonId: p.lessonId ?? null, topic: p.topic ?? "", turns };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { lessonId: null, topic: "", turns: [] };
}

let turnSeq = 0;
const initial = loadPersisted();

export const useLessonStore = create<LessonStoreState>((set) => ({
  ...initial,
  status: "idle",
  progress: null,
  currentQuestion: null,
  error: null,

  beginTurn: (prompt) => {
    const id = `t${Date.now()}-${++turnSeq}`;
    set((s) => ({
      turns: [...s.turns, { id, user: prompt, steps: [], state: "streaming" as const }].slice(-MAX_TURNS),
      topic: s.topic || prompt,
      status: "teaching",
      progress: "Understanding your question",
      currentQuestion: null,
      error: null,
    }));
    return id;
  },

  setLessonId: (lessonId) => set({ lessonId }),
  setTopic: (topic) => set({ topic }),
  setProgress: (progress) => set({ progress }),

  addStep: (step) =>
    set((s) => updateLast(s.turns, (t) => ({ ...t, steps: [...t.steps, step] }))),

  setQuestion: (question) =>
    set((s) => ({
      currentQuestion: question,
      status: question ? "waiting_for_user" : s.status,
      ...(question ? updateLast(s.turns, (t) => ({ ...t, question })) : {}),
    })),

  setNotice: (notice) => set((s) => updateLast(s.turns, (t) => ({ ...t, notice }))),
  setSketch: (sketch) => set((s) => updateLast(s.turns, (t) => ({ ...t, sketch }))),
  setSketchReview: (turnId, review) =>
    set((s) => ({ turns: s.turns.map((t) => (t.id === turnId && t.sketch ? { ...t, sketch: { ...t.sketch, review } } : t)) })),
  addMeta: (meta) => set((s) => updateLast(s.turns, (t) => ({ ...t, meta: [...(t.meta ?? []), meta] }))),

  finishTurn: (state, error) =>
    set((s) => ({
      ...updateLast(s.turns, (t) => (t.state === "streaming" ? { ...t, state, ...(error ? { error } : {}) } : t)),
      progress: null,
    })),

  removeUndoneTurn: (user, topic) =>
    set((s) => {
      let i = user === null ? -1 : s.turns.map((t) => t.user).lastIndexOf(user);
      if (i === -1) {
        // No exact match: drop trailing unfinished attempts, then the last completed turn.
        i = s.turns.length - 1;
        while (i > 0 && s.turns[i].state !== "done") i--;
      }
      return { turns: s.turns.slice(0, Math.max(0, i)), topic, currentQuestion: null, error: null, status: "idle" as const };
    }),

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),

  reset: () =>
    set({ lessonId: null, topic: "", turns: [], status: "idle", progress: null, currentQuestion: null, error: null }),
}));

function updateLast(turns: Turn[], fn: (t: Turn) => Turn): { turns: Turn[] } {
  if (!turns.length) return { turns };
  return { turns: [...turns.slice(0, -1), fn(turns[turns.length - 1])] };
}

// Persist the user-visible conversation (debounced via microtask batching by zustand).
useLessonStore.subscribe((s, prev) => {
  if (s.turns === prev.turns && s.lessonId === prev.lessonId && s.topic === prev.topic) return;
  try {
    const data: Persisted = { lessonId: s.lessonId, topic: s.topic, turns: s.turns };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota exceeded / private mode — persistence is best-effort */
  }
});
