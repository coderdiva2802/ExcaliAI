// ─────────────────────────────────────────────────────────
// Canvas Element Types
// The simplified, stable view of the canvas that the client
// sends to the server each turn.  The server never touches
// Excalidraw internals.
// ─────────────────────────────────────────────────────────

/** Element types the AI-facing canvas model distinguishes. */
export type CanvasElementType =
  | "text"
  | "rectangle"
  | "circle"
  | "diamond"
  | "arrow"
  | "line"
  | "formula"
  | "code"
  | "freedraw"
  | "other";

export interface CanvasElement {
  /** DSL element ID (or the Excalidraw ID for user-drawn elements). */
  id: string;
  type: CanvasElementType;

  // ── Position & size ──────────────────────────────────
  x: number;
  y: number;
  width?: number;
  height?: number;

  // ── Content ──────────────────────────────────────────
  /** Text content (text elements) or the bound label of a shape/arrow. */
  text?: string;
  /** LaTeX source (formula elements). */
  latex?: string;
  /** Source code (code elements). */
  code?: string;
  language?: string;

  // ── Relationships ────────────────────────────────────
  fromId?: string;
  toId?: string;

  /** Diagram this element was generated for (absent for user-drawn elements). */
  diagramId?: string;
}

/** The full serialized canvas state sent to the server before each turn. */
export interface CanvasState {
  elements: CanvasElement[];
  viewport: {
    scrollX: number;
    scrollY: number;
    zoom: number;
  };
}
