// ─────────────────────────────────────────────────────────
// Zod schemas for every Visual DSL action.
//
// Used on the server (final gate before anything is streamed)
// and on the frontend (defense in depth before execution).
// Schemas are strict about structure and lenient-but-safe
// about cosmetic fields: an unparseable color is dropped
// rather than rejecting the whole element.
// ─────────────────────────────────────────────────────────

import { z } from "zod";

// ── Shared field helpers ───────────────────────────────

/** Coordinates are clamped to a sane canvas range. */
const MAX_COORD = 200_000;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_\-.:]+$/, "invalid id");
const coord = z.number().finite().min(-MAX_COORD).max(MAX_COORD);
const dimension = z.number().finite().positive().max(20_000);
const fontSize = z.number().finite().min(8).max(96).optional();

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

/** Normalize "#abc" → "#aabbcc"; anything else that is not "#rrggbb" becomes undefined. */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v === "transparent") return v;
  if (HEX6.test(v)) return v.toLowerCase();
  if (HEX3.test(v)) {
    return ("#" + v.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  }
  return undefined;
}

const color = z.preprocess(normalizeColor, z.string().optional());
const strokeStyle = z.enum(["solid", "dashed", "dotted"]).optional().catch(undefined);
const shortText = z.string().max(500).optional();
const diagramId = id.optional();

// ── Element Creation ───────────────────────────────────

export const CreateTextSchema = z.object({
  action: z.literal("create_text"),
  id,
  diagramId,
  text: z.string().min(1).max(2000),
  x: coord,
  y: coord,
  fontSize,
  color,
  fontFamily: z.enum(["sketch", "clean", "mono"]).optional().catch(undefined),
  align: z.enum(["left", "center"]).optional().catch(undefined),
});

const shapeFields = {
  id,
  diagramId,
  x: coord,
  y: coord,
  width: dimension,
  height: dimension,
  label: shortText,
  labelColor: color,
  labelFontSize: fontSize,
  strokeColor: color,
  backgroundColor: color,
  strokeStyle,
};

export const CreateRectangleSchema = z.object({
  action: z.literal("create_rectangle"),
  ...shapeFields,
  rounded: z.boolean().optional(),
});

export const CreateCircleSchema = z.object({
  action: z.literal("create_circle"),
  ...shapeFields,
});

export const CreateDiamondSchema = z.object({
  action: z.literal("create_diamond"),
  ...shapeFields,
});

const arrowhead = z.enum(["arrow", "triangle", "none"]).optional().catch(undefined);

export const CreateArrowSchema = z
  .object({
    action: z.literal("create_arrow"),
    id,
    diagramId,
    fromId: id.optional(),
    toId: id.optional(),
    startX: coord.optional(),
    startY: coord.optional(),
    endX: coord.optional(),
    endY: coord.optional(),
    waypoints: z.array(z.tuple([coord, coord])).max(16).optional(),
    label: shortText,
    color,
    strokeStyle,
    endArrowhead: arrowhead,
    startArrowhead: arrowhead,
    curved: z.boolean().optional(),
  })
  .refine(
    (a) =>
      (a.fromId !== undefined || (a.startX !== undefined && a.startY !== undefined)) &&
      (a.toId !== undefined || (a.endX !== undefined && a.endY !== undefined)),
    { message: "arrow needs a start (fromId or startX/startY) and an end (toId or endX/endY)" }
  );

export const CreateLineSchema = z.object({
  action: z.literal("create_line"),
  id,
  diagramId,
  startX: coord,
  startY: coord,
  endX: coord,
  endY: coord,
  color,
  strokeStyle,
});

export const CreatePathSchema = z.object({
  action: z.literal("create_path"),
  id,
  diagramId,
  points: z.array(z.tuple([coord, coord])).min(2).max(2000),
  closed: z.boolean().optional(),
  smooth: z.boolean().optional(),
  color,
  backgroundColor: color,
  strokeWidth: z.number().min(0.5).max(16).optional(),
  strokeStyle,
  endArrowhead: arrowhead,
  startArrowhead: arrowhead,
  opacity: z.number().min(0).max(100).optional(),
});

export const CreateFormulaSchema = z.object({
  action: z.literal("create_formula"),
  id,
  diagramId,
  latex: z.string().min(1).max(2000),
  x: coord,
  y: coord,
  fontSize,
  width: dimension.optional(),
  height: dimension.optional(),
});

export const CreateCodeSchema = z.object({
  action: z.literal("create_code"),
  id,
  diagramId,
  code: z.string().min(1).max(10000),
  language: z.string().min(1).max(30),
  x: coord,
  y: coord,
  width: dimension.optional(),
  height: dimension.optional(),
});

// ── Element Manipulation ───────────────────────────────

export const HighlightElementSchema = z.object({
  action: z.literal("highlight_element"),
  elementId: id,
  color,
});

export const MoveElementSchema = z.object({
  action: z.literal("move_element"),
  elementId: id,
  x: coord,
  y: coord,
});

export const UpdateElementSchema = z
  .object({
    action: z.literal("update_element"),
    elementId: id,
    label: z.string().max(500).optional(),
    strokeColor: color,
    backgroundColor: color,
    opacity: z.number().min(0).max(100).optional(),
  })
  .refine((u) => u.label !== undefined || u.strokeColor || u.backgroundColor || u.opacity !== undefined, {
    message: "update_element must change something",
  });

export const DeleteElementSchema = z.object({
  action: z.literal("delete_element"),
  elementId: id,
});

// ── Canvas Control ─────────────────────────────────────

export const PanToSchema = z.object({
  action: z.literal("pan_to"),
  x: coord,
  y: coord,
  zoom: z.number().min(0.1).max(10).optional(),
});

export const FocusDiagramSchema = z.object({
  action: z.literal("focus_diagram"),
  diagramId: id,
});

export const WaitSchema = z.object({
  action: z.literal("wait"),
  durationMs: z.number().int().min(100).max(10000).optional(),
});

// ── Interaction ────────────────────────────────────────

export const NarrateSchema = z.object({
  action: z.literal("narrate"),
  text: z.string().min(1).max(5000),
  title: z.string().max(200).optional(),
});

export const AskUserSchema = z.object({
  action: z.literal("ask_user"),
  question: z.string().min(1).max(2000),
});

// ── Union schema ───────────────────────────────────────
// (A plain union rather than discriminatedUnion because the arrow
//  schema carries a refinement.)

const SCHEMAS = {
  create_text: CreateTextSchema,
  create_rectangle: CreateRectangleSchema,
  create_circle: CreateCircleSchema,
  create_diamond: CreateDiamondSchema,
  create_arrow: CreateArrowSchema,
  create_line: CreateLineSchema,
  create_path: CreatePathSchema,
  create_formula: CreateFormulaSchema,
  create_code: CreateCodeSchema,
  highlight_element: HighlightElementSchema,
  move_element: MoveElementSchema,
  update_element: UpdateElementSchema,
  delete_element: DeleteElementSchema,
  pan_to: PanToSchema,
  focus_diagram: FocusDiagramSchema,
  wait: WaitSchema,
  narrate: NarrateSchema,
  ask_user: AskUserSchema,
} as const;

export const DSLActionSchema = z.union([
  CreateTextSchema,
  CreateRectangleSchema,
  CreateCircleSchema,
  CreateDiamondSchema,
  CreateArrowSchema,
  CreateLineSchema,
  CreatePathSchema,
  CreateFormulaSchema,
  CreateCodeSchema,
  HighlightElementSchema,
  MoveElementSchema,
  UpdateElementSchema,
  DeleteElementSchema,
  PanToSchema,
  FocusDiagramSchema,
  WaitSchema,
  NarrateSchema,
  AskUserSchema,
]);

export type ValidatedAction = z.infer<typeof DSLActionSchema>;

/**
 * Safe validation — dispatches on the `action` field so errors are
 * specific to the intended action type instead of a union-wide dump.
 */
export function safeValidateAction(data: unknown):
  | { success: true; data: ValidatedAction }
  | { success: false; error: string } {
  const kind = (data as { action?: unknown } | null)?.action;
  if (typeof kind !== "string" || !(kind in SCHEMAS)) {
    return { success: false, error: `unknown action "${String(kind)}"` };
  }
  const result = SCHEMAS[kind as keyof typeof SCHEMAS].safeParse(data);
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; "),
    };
  }
  return { success: true, data: result.data as ValidatedAction };
}
