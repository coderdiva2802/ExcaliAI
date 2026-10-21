// ─────────────────────────────────────────────────────────
// Header — brand, current topic, undo last answer, new lesson.
// ─────────────────────────────────────────────────────────

import { SquarePen, Sparkles, Undo2 } from "lucide-react";
import { useLessonStore } from "../../store/lessonStore";

interface HeaderProps {
  onNewLesson: () => void;
  onUndo: () => void;
  undoing: boolean;
}

export function Header({ onNewLesson, onUndo, undoing }: HeaderProps) {
  const topic = useLessonStore((s) => s.topic);
  const status = useLessonStore((s) => s.status);
  const hasLesson = useLessonStore((s) => s.turns.length > 0);
  const canUndo = useLessonStore((s) => Boolean(s.lessonId) && s.turns.some((t) => t.state === "done"));
  const busy = status === "teaching";

  return (
    <header className="pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100vw-2rem)] items-center gap-2">
      <div className="surface pointer-events-auto flex h-11 min-w-0 items-center gap-3 rounded-xl pl-3 pr-2">
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-500/90 text-white">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight text-slate-100">ExcaliAI</span>
        </div>

        {topic && (
          <>
            <span className="h-5 w-px shrink-0 bg-white/10" aria-hidden />
            <span className="flex min-w-0 items-center gap-2 text-sm text-slate-300" title={topic}>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${busy ? "animate-pulse bg-indigo-400" : "bg-emerald-400"}`}
                aria-label={busy ? "Tutor is working" : "Ready"}
              />
              <span className="max-w-[16rem] truncate">{topic}</span>
            </span>
          </>
        )}

        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            disabled={undoing}
            className="btn-ghost ml-1 shrink-0 disabled:opacity-50"
            title="Undo the tutor's last answer and its changes to the board"
            aria-label="Undo last answer"
          >
            <Undo2 className={`h-4 w-4 ${undoing ? "animate-pulse" : ""}`} aria-hidden />
            <span className="hidden sm:inline">Undo</span>
          </button>
        )}

        {hasLesson && (
          <button type="button" onClick={onNewLesson} className="btn-ghost ml-1 shrink-0" title="Clear the board and start a new lesson">
            <SquarePen className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">New lesson</span>
          </button>
        )}
      </div>
    </header>
  );
}
