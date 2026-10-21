// ─────────────────────────────────────────────────────────
// App — wires the canvas, the action engine, the stream and
// the UI together.  App is the only writer of lesson status.
// ─────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Binary, BrainCircuit, GitBranch, Network, PanelRightOpen } from "lucide-react";
import { CanvasContainer, clearSavedScene } from "./components/Canvas/CanvasContainer";
import { PromptBar } from "./components/Prompt/PromptBar";
import { LessonPanel } from "./components/Narration/LessonPanel";
import { Header } from "./components/Layout/Header";
import { CanvasController } from "./engine/CanvasController";
import { ActionEngine } from "./engine/ActionEngine";
import { StreamError, streamTurn, undoTurn } from "./services/sse";
import { useLessonStore } from "./store/lessonStore";

const SUGGESTIONS = [
  { title: "Binary search", desc: "How halving the search space works", icon: Binary, prompt: "Explain binary search" },
  { title: "TCP handshake", desc: "SYN, SYN-ACK and ACK step by step", icon: Network, prompt: "Explain the TCP three-way handshake" },
  { title: "Transformer attention", desc: "Queries, keys and values", icon: BrainCircuit, prompt: "How does self-attention in transformers work?" },
  { title: "Git merge vs rebase", desc: "Two ways to combine branches", icon: GitBranch, prompt: "Compare git merge and git rebase" },
];

const PANEL_WIDTH = 376; // panel width + margin, desktop only

function useIsDesktop(): boolean {
  const query = "(min-width: 768px)";
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return matches;
}

export default function App() {
  const [controller] = useState(() => new CanvasController());
  const abortRef = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const isDesktop = useIsDesktop();
  const [panelOpen, setPanelOpen] = useState(isDesktop);
  // The notes panel covers the canvas on phones: close it when the viewport becomes narrow.
  useEffect(() => {
    if (!isDesktop) setPanelOpen(false);
  }, [isDesktop]);
  const hasTurns = useLessonStore((s) => s.turns.length > 0);

  const engine = useMemo(
    () =>
      new ActionEngine({
        execute: (action) => controller.executeAction(action),
        narrate: (text, title) => useLessonStore.getState().addStep({ text, title }),
        ask: (question) => useLessonStore.getState().setQuestion(question),
        idle: () => {
          const s = useLessonStore.getState();
          if (s.status === "teaching") s.setStatus(s.currentQuestion ? "waiting_for_user" : "idle");
          s.setProgress(null);
        },
      }),
    [controller]
  );

  // Keep diagram focusing centered on the part of the canvas that isn't covered by UI.
  const panelInset = isDesktop && panelOpen && hasTurns ? PANEL_WIDTH : 0;
  useEffect(() => {
    controller.setViewportInsets({ right: panelInset, top: isDesktop ? 72 : 260, bottom: 150 });
  }, [controller, panelInset, isDesktop]);

  const handleAPIReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      controller.setAPI(api);
      setReady(true);
    },
    [controller]
  );

  const handleSubmit = useCallback(
    async (message: string) => {
      const store = useLessonStore.getState();
      if (store.status === "teaching" || !controller.ready) return;

      engine.clear();
      store.setQuestion(null);
      store.beginTurn(message);
      if (!isDesktop) setPanelOpen(false);
      else setPanelOpen(true);

      const ac = new AbortController();
      abortRef.current = ac;
      engine.beginStream();
      const canvasState = controller.serializeForAI();

      const fail = (msg: string) => {
        const s = useLessonStore.getState();
        s.finishTurn("error", msg);
        setPanelOpen(true);
        engine.endStream();
      };

      try {
        await streamTurn(
          store.lessonId,
          message,
          canvasState,
          {
            onLesson: (id) => useLessonStore.getState().setLessonId(id),
            onProgress: (label) => useLessonStore.getState().setProgress(label),
            onAction: (action) => engine.enqueue(action),
            onNotice: (msg) => useLessonStore.getState().setNotice(msg),
            onSketch: (sketch) => useLessonStore.getState().setSketch(sketch),
            onMeta: (meta) => useLessonStore.getState().addMeta(meta),
            onError: (msg) => fail(msg),
            onDone: (topic) => {
              const s = useLessonStore.getState();
              if (topic) s.setTopic(topic);
              s.finishTurn("done");
              engine.endStream();
            },
          },
          ac.signal
        );
      } catch (err) {
        if (ac.signal.aborted) return;
        console.error("Turn failed:", err);
        fail(err instanceof StreamError ? err.message : "Something went wrong. Please try again.");
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [controller, engine, isDesktop]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    engine.clear();
    const s = useLessonStore.getState();
    s.finishTurn("cancelled");
    s.setStatus("idle");
  }, [engine]);

  const [undoing, setUndoing] = useState(false);
  const handleUndo = useCallback(async () => {
    const { lessonId } = useLessonStore.getState();
    if (!lessonId || undoing || !controller.ready) return;
    handleStop(); // a turn still being generated is cancelled, not undone
    setUndoing(true);
    try {
      const result = await undoTurn(lessonId);
      for (const action of result.actions) await controller.executeAction(action);
      useLessonStore.getState().removeUndoneTurn(result.undone, result.topic);
    } catch (err) {
      const message = err instanceof StreamError ? err.message : "Couldn't undo the last answer.";
      useLessonStore.getState().setError({ message, retryable: false });
    } finally {
      setUndoing(false);
    }
  }, [controller, handleStop, undoing]);

  const handleNewLesson = useCallback(() => {
    handleStop();
    controller.clear();
    clearSavedScene();
    useLessonStore.getState().reset();
  }, [controller, handleStop]);

  // Cancel any in-flight request when the page goes away.
  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <CanvasContainer onAPIReady={handleAPIReady} />

      <Header onNewLesson={handleNewLesson} onUndo={handleUndo} undoing={undoing} />

      <LessonPanel open={panelOpen} onToggle={() => setPanelOpen(false)} onRetry={handleSubmit} />
      {hasTurns && !panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="surface btn-ghost absolute left-4 top-[4.25rem] z-20 h-10 rounded-xl px-3 md:left-auto md:right-4 md:top-4 md:h-11"
          aria-label="Show lesson notes"
        >
          <PanelRightOpen className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Notes</span>
        </button>
      )}

      {!hasTurns && ready && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 pb-40">
          <div className="max-w-xl text-center animate-fade-in">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">Learn anything, visually.</h1>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-slate-400">
              Ask about a concept and the tutor explains it step by step while drawing a diagram. Follow up, or ask it to change the diagram.
            </p>
            <div className="pointer-events-auto mt-8 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
              {SUGGESTIONS.map(({ title, desc, icon: Icon, prompt }) => (
                <button key={title} type="button" onClick={() => handleSubmit(prompt)} className="suggestion">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" aria-hidden />
                  <span>
                    <span className="block text-sm font-medium text-slate-100">{title}</span>
                    <span className="block text-xs text-slate-400">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <PromptBar onSubmit={handleSubmit} onStop={handleStop} disabled={!ready} rightInset={panelInset} compact={!isDesktop} />
    </div>
  );
}
