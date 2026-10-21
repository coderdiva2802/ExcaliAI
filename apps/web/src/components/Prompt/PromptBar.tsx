// ─────────────────────────────────────────────────────────
// Prompt Bar — message input, stop control, tutor questions
// and quick follow-up suggestions.
// ─────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useLessonStore } from "../../store/lessonStore";

const FOLLOW_UPS = ["Make the diagram simpler", "Add an example", "Go one level deeper", "Quiz me on this"];

interface PromptBarProps {
  onSubmit: (message: string) => void;
  onStop: () => void;
  disabled?: boolean;
  /** Extra right padding (px) so the bar centers on the visible canvas. */
  rightInset: number;
  /** Phone layout: shorter copy, single-row chips. */
  compact?: boolean;
}

export function PromptBar({ onSubmit, onStop, disabled, rightInset, compact }: PromptBarProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status = useLessonStore((s) => s.status);
  const progress = useLessonStore((s) => s.progress);
  const currentQuestion = useLessonStore((s) => s.currentQuestion);
  const hasLesson = useLessonStore((s) => s.turns.length > 0);

  const busy = status === "teaching";
  const canSend = !disabled && !busy && value.trim().length > 0;

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || disabled || busy) return;
      onSubmit(trimmed);
      setValue("");
    },
    [disabled, busy, onSubmit]
  );

  // Auto-grow the textarea up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // Return focus to the input when the tutor is done or asks something.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy, currentQuestion]);

  const placeholder = currentQuestion
    ? "Type your answer…"
    : hasLesson
      ? compact ? "Ask a follow-up…" : "Ask a follow-up, or ask to change the diagram…"
      : compact ? "What do you want to learn?" : "What would you like to understand? e.g. “How does binary search work?”";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-4 transition-[padding]" style={{ paddingRight: rightInset + 12 }}>
      <div className="pointer-events-auto w-full max-w-2xl space-y-2">
        {currentQuestion && !busy && (
          <div className="surface rounded-xl px-4 py-3 animate-slide-up">
            <p className="text-[11px] font-medium uppercase tracking-wide text-sky-300">The tutor asks</p>
            <p className="mt-1 text-sm text-slate-100 select-text">{currentQuestion}</p>
          </div>
        )}

        {hasLesson && !busy && !currentQuestion && (
          <div className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 md:mx-0 md:flex-wrap md:justify-center md:px-0" aria-label="Suggested follow-ups">
            {FOLLOW_UPS.map((s) => (
              <button key={s} type="button" className="chip shrink-0" onClick={() => submit(s)} disabled={disabled}>
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="surface flex items-end gap-2 rounded-2xl p-2 focus-within:ring-1 focus-within:ring-indigo-400/50"
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <label htmlFor="prompt" className="sr-only">
            Message the tutor
          </label>
          <textarea
            id="prompt"
            ref={inputRef}
            rows={1}
            value={value}
            maxLength={2000}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(value);
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-50"
          />
          {busy ? (
            <button type="button" onClick={onStop} className="btn-primary bg-white/10 hover:bg-white/15" aria-label="Stop" title="Stop">
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button type="submit" disabled={!canSend} className="btn-primary" aria-label="Send" title="Send (Enter)">
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </form>

        <p className="flex h-4 items-center justify-center gap-1.5 text-center text-[11px] text-slate-500" aria-live="polite">
          {busy ? (
            <>
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
              {progress ?? "Working"}…
            </>
          ) : (
            "Enter to send · Shift+Enter for a new line"
          )}
        </p>
      </div>
    </div>
  );
}
