// ─────────────────────────────────────────────────────────
// Visual DSL — Action Types
//
// Every canvas mutation is expressed as one of these actions.
// The server's diagram compiler is the ONLY producer of these
// actions (the LLM never emits them directly); the frontend
// re-validates and executes them via the ActionEngine.
// ─────────────────────────────────────────────────────────

/** Font families exposed to the DSL (mapped to Excalidraw fonts on the client). */
export type DSLFontFamily = "sketch" | "clean" | "mono";
export type DSLStrokeStyle = "solid" | "dashed" | "dotted";

/** Fields shared by every element-creating action. */
interface ElementBase {
  /** Stable, unique element ID (e.g. "d1__node_root"). */
  id: string;
  /** Diagram this element belongs to — used for grouping, focus and edits. */
  diagramId?: string;
}

/** Fields shared by closed shapes that can carry a centered label. */
interface ShapeBase extends ElementBase {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  labelColor?: string;
  labelFontSize?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeStyle?: DSLStrokeStyle;
}

// ── Element Creation ───────────────────────────────────

export interface CreateTextAction extends ElementBase {
  action: "create_text";
  text: string;
  /** Left edge — or the horizontal centre when `align` is "center" (Excalidraw's anchoring). */
  x: number;
  y: number;
  fontSize?: number;
  color?: string;
  fontFamily?: DSLFontFamily;
  align?: "left" | "center";
}

export interface CreateRectangleAction extends ShapeBase {
  action: "create_rectangle";
  rounded?: boolean;
}

export interface CreateCircleAction extends ShapeBase {
  action: "create_circle";
}

export interface CreateDiamondAction extends ShapeBase {
  action: "create_diamond";
}

export interface CreateArrowAction extends ElementBase {
  action: "create_arrow";
  /** Source element ID — the arrow is bound to this element. */
  fromId?: string;
  /** Target element ID — the arrow is bound to this element. */
  toId?: string;
  /** Explicit start point (absolute). Computed from fromId when omitted. */
  startX?: number;
  startY?: number;
  /** Explicit end point (absolute). Computed from toId when omitted. */
  endX?: number;
  endY?: number;
  /** Optional intermediate waypoints (absolute) for routed arrows. */
  waypoints?: Array<[number, number]>;
  label?: string;
  color?: string;
  strokeStyle?: DSLStrokeStyle;
  /** Smooth curve through the waypoints instead of straight segments. */
  curved?: boolean;
  /** "none" draws an undirected connector. Defaults to "arrow". */
  endArrowhead?: "arrow" | "triangle" | "none";
  startArrowhead?: "arrow" | "triangle" | "none";
}

export interface CreateLineAction extends ElementBase {
  action: "create_line";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color?: string;
  strokeStyle?: DSLStrokeStyle;
}

/**
 * Free-form multi-point path: plots, curves, polygons, arcs, axes, braces.
 * Closed paths (last point = first point) can be filled.
 */
export interface CreatePathAction extends ElementBase {
  action: "create_path";
  /** Absolute canvas points, at least 2. */
  points: Array<[number, number]>;
  closed?: boolean;
  /** Smooth curve through the points (otherwise straight segments). */
  smooth?: boolean;
  color?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: DSLStrokeStyle;
  endArrowhead?: "arrow" | "triangle" | "none";
  startArrowhead?: "arrow" | "triangle" | "none";
  opacity?: number;
}

export interface CreateFormulaAction extends ElementBase {
  action: "create_formula";
  latex: string;
  x: number;
  y: number;
  fontSize?: number;
  /** Layout-engine size estimate, used for collision checks. */
  width?: number;
  height?: number;
}

export interface CreateCodeAction extends ElementBase {
  action: "create_code";
  code: string;
  language: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

// ── Element Manipulation ───────────────────────────────

export interface HighlightElementAction {
  action: "highlight_element";
  elementId: string;
  color?: string;
}

export interface MoveElementAction {
  action: "move_element";
  elementId: string;
  x: number;
  y: number;
}

/** Change an existing element in place (label, colors, visibility) without re-creating it. */
export interface UpdateElementAction {
  action: "update_element";
  elementId: string;
  label?: string;
  strokeColor?: string;
  backgroundColor?: string;
  /** 0–100; 0 hides the element (used for step-by-step state changes). */
  opacity?: number;
}

export interface DeleteElementAction {
  action: "delete_element";
  elementId: string;
}

// ── Canvas Control ─────────────────────────────────────

export interface PanToAction {
  action: "pan_to";
  x: number;
  y: number;
  zoom?: number;
}

/** Fit the viewport to every element of a diagram. */
export interface FocusDiagramAction {
  action: "focus_diagram";
  diagramId: string;
}

export interface WaitAction {
  action: "wait";
  /** Duration in milliseconds. Defaults to 800ms. */
  durationMs?: number;
}

// ── Interaction ────────────────────────────────────────

export interface NarrateAction {
  action: "narrate";
  text: string;
  /** Optional short heading for the explanation step. */
  title?: string;
}

export interface AskUserAction {
  action: "ask_user";
  question: string;
}

// ── Discriminated Union ────────────────────────────────

export type DSLAction =
  | CreateTextAction
  | CreateRectangleAction
  | CreateCircleAction
  | CreateDiamondAction
  | CreateArrowAction
  | CreateLineAction
  | CreatePathAction
  | CreateFormulaAction
  | CreateCodeAction
  | HighlightElementAction
  | MoveElementAction
  | UpdateElementAction
  | DeleteElementAction
  | PanToAction
  | FocusDiagramAction
  | WaitAction
  | NarrateAction
  | AskUserAction;

/** All valid action names. */
export type DSLActionType = DSLAction["action"];

/** Extract the payload for a specific action name. */
export type ActionPayload<T extends DSLActionType> = Extract<
  DSLAction,
  { action: T }
>;

/** Actions that create a canvas element (and therefore carry an `id`). */
export type CreateAction = Extract<DSLAction, { id: string }>;
