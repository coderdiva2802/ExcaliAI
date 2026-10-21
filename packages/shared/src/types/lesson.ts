// ─────────────────────────────────────────────────────────
// Lesson Types
// ─────────────────────────────────────────────────────────

/** Current teaching status of a lesson, as seen by the UI. */
export type LessonStatus =
  | "idle"              // Ready for input
  | "teaching"          // A turn is streaming / being drawn
  | "waiting_for_user"  // The tutor asked a question
  | "error";            // The last turn failed
