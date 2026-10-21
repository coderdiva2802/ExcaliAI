// ─────────────────────────────────────────────────────────
// Lesson Panel — the conversation: each user message with the
// tutor's explanation steps, questions, notices and errors.
// ─────────────────────────────────────────────────────────

import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Info, LoaderCircle, PanelRightClose, PenLine, RotateCcw, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { useLessonStore, type Turn } from "../../store/lessonStore";
import { reviewSketch, StreamError } from "../../services/sse";

/** Developer panel: enable with ?debug in the URL (remembered) — shows which provider/model answered. */
const DEBUG = (() => {
  try {
    if (new URLSearchParams(window.location.search).has("debug")) localStorage.setItem("excaliai.debug", "1");
    return localStorage.getItem("excaliai.debug") === "1";
  } catch {
    return false;
  }
})();

interface LessonPanelProps {
  open: boolean;
  onToggle: () => void;
  onRetry: (prompt: string) => void;
}

export function LessonPanel({ open, onToggle, onRetry }: LessonPanelProps) {
  const turns = useLessonStore((s) => s.turns);
  const progress = useLessonStore((s) => s.progress);
  const status = useLessonStore((s) => s.status);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Keep the newest content in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, progress]);

  if (!open || turns.length === 0) return null;

  const copyNotes = async () => {
    const text = turns
      .map((t) => [`Q: ${t.user}`, ...t.steps.map((s, i) => `${i + 1}. ${s.title ? `${s.title}: ` : ""}${s.text}`)].join("\n"))
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <aside
      className="surface absolute inset-x-3 top-[4.25rem] z-20 flex max-h-[45vh] flex-col rounded-2xl md:inset-x-auto md:bottom-4 md:right-4 md:top-4 md:max-h-none md:w-[360px]"
      aria-label="Lesson notes"
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">Lesson notes</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={copyNotes} className="btn-icon" aria-label="Copy notes" title="Copy notes">
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </button>
          <button type="button" onClick={onToggle} className="btn-icon" aria-label="Hide notes" title="Hide notes">
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-4 py-4" aria-live="polite">
        {turns.map((turn, i) => (
          <TurnView key={turn.id} turn={turn} isLast={i === turns.length - 1} onRetry={onRetry} />
        ))}
        {status === "teaching" && progress && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden />
            <span>{progress}…</span>
          </div>
        )}
      </div>
    </aside>
  );
}

const SOURCE_LABEL = { local: "Your reference library", commons: "Wikimedia Commons", ai: "AI sketch" } as const;

/** Where a sketched diagram came from, with Keep / Bad sketch buttons for a draft this lesson created. */
function SketchCard({ turnId, sketch }: { turnId: string; sketch: NonNullable<Turn["sketch"]> }) {
  const lessonId = useLessonStore((s) => s.lessonId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = async (action: "approve" | "reject") => {
    if (!lessonId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reviewSketch(sketch.sketchId, lessonId, action);
      useLessonStore.getState().setSketchReview(turnId, action === "approve" ? "approved" : "rejected");
    } catch (err) {
      setError(err instanceof StreamError ? err.message : "Couldn't save your review.");
    } finally {
      setBusy(false);
    }
  };
  const reviewable = sketch.canReview && !sketch.review;
  return (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-300" aria-label="Sketch source">
      <p className="flex items-start gap-2">
        <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-slate-200">Sketched: {sketch.title}</span>
          <span className="text-slate-400"> · {SOURCE_LABEL[sketch.source]}</span>
          {sketch.credit && sketch.source !== "ai" && <span className="block text-[11px] text-slate-400 select-text">{sketch.credit}</span>}
        </span>
        {sketch.url && (
          <a href={sketch.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-slate-400 hover:text-slate-200" title="Open the source diagram" aria-label="Open the source diagram">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </p>
      {reviewable && (
        <div className="flex flex-wrap items-center gap-2 pl-5">
          <span className="text-[11px] text-slate-400">Reuse this drawing in future lessons?</span>
          <button type="button" disabled={busy} onClick={() => review("approve")} className="inline-flex items-center gap-1 rounded-md bg-emerald-400/10 px-2 py-0.5 font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-50">
            <ThumbsUp className="h-3 w-3" aria-hidden /> Keep
          </button>
          <button type="button" disabled={busy} onClick={() => review("reject")} className="inline-flex items-center gap-1 rounded-md bg-rose-400/10 px-2 py-0.5 font-medium text-rose-200 hover:bg-rose-400/20 disabled:opacity-50">
            <ThumbsDown className="h-3 w-3" aria-hidden /> Bad sketch
          </button>
        </div>
      )}
      {sketch.review === "approved" && <p className="pl-5 text-[11px] text-emerald-300">Saved: future lessons will reuse this drawing.</p>}
      {sketch.review === "rejected" && <p className="pl-5 text-[11px] text-rose-300">Removed: ask again to get a fresh sketch.</p>}
      {sketch.status === "approved" && !sketch.review && sketch.source !== "local" && <p className="pl-5 text-[11px] text-slate-500">From the shared sketch library.</p>}
      {error && <p className="pl-5 text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

const TurnView = memo(function TurnView({ turn, isLast, onRetry }: { turn: Turn; isLast: boolean; onRetry: (p: string) => void }) {
  return (
    <section className="space-y-3">
      <p className="ml-6 rounded-xl rounded-tr-sm bg-indigo-500/15 px-3 py-2 text-sm text-indigo-100 select-text">{turn.user}</p>

      {turn.steps.length > 0 && (
        <ol className="space-y-3">
          {turn.steps.map((step, i) => (
            <li key={i} className="flex gap-3 animate-fade-in">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/[0.07] text-[11px] font-medium text-slate-300">
                {i + 1}
              </span>
              <div className="min-w-0 select-text">
                {step.title && <p className="text-[13px] font-semibold text-slate-100">{step.title}</p>}
                <p className="text-[13px] leading-relaxed text-slate-300">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {turn.question && (
        <p className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-[13px] text-sky-100 select-text">{turn.question}</p>
      )}
      {turn.notice && (
        <p className="flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-100">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {turn.notice}
        </p>
      )}
      {turn.sketch && <SketchCard turnId={turn.id} sketch={turn.sketch} />}
      {turn.state === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[12px] text-rose-100">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{turn.error ?? "Something went wrong."}</span>
          {isLast && (
            <button type="button" className="inline-flex items-center gap-1 font-medium text-rose-50 hover:underline" onClick={() => onRetry(turn.user)}>
              <RotateCcw className="h-3 w-3" aria-hidden /> Retry
            </button>
          )}
        </div>
      )}
      {turn.state === "cancelled" && <p className="text-[12px] text-slate-500">Stopped.</p>}
      {DEBUG && turn.meta?.length ? (
        <p className="font-mono text-[10px] leading-relaxed text-slate-500" aria-label="AI debug info">
          {turn.meta.map((m, i) => (
            <span key={i} className="block">
              {m.task} · {m.provider} · {m.model} · {(m.ms / 1000).toFixed(1)}s
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
});
