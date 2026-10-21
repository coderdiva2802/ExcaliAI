// ─────────────────────────────────────────────────────────
// Final canvas-operation gate.
//
// Runs on the fully compiled action list right before it is
// streamed.  Structural (schema), referential (ids, bindings)
// and geometric (overlap, bounds) checks.  Invalid operations
// are repaired when safe, otherwise dropped — they never reach
// the client.
// ─────────────────────────────────────────────────────────

import type { CanvasElement, DSLAction } from "@excaliai/shared";
import { safeValidateAction } from "@excaliai/visual-dsl";

export interface GateResult {
  actions: DSLAction[];
  warnings: string[];
}

interface Box { id: string; x: number; y: number; w: number; h: number }

function boxOf(a: DSLAction): Box | null {
  switch (a.action) {
    case "create_rectangle":
    case "create_circle":
    case "create_diamond":
      return { id: a.id, x: a.x, y: a.y, w: a.width, h: a.height };
    case "create_formula":
    case "create_code":
      return a.width && a.height ? { id: a.id, x: a.x, y: a.y, w: a.width, h: a.height } : null;
    default:
      return null;
  }
}

/** Liang–Barsky segment/rectangle intersection. */
function segmentCrossesBox(p1: [number, number], p2: [number, number], r: { x: number; y: number; w: number; h: number }): boolean {
  let t0 = 0, t1 = 1;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const tests: Array<[number, number]> = [[-dx, p1[0] - r.x], [dx, r.x + r.w - p1[0]], [-dy, p1[1] - r.y], [dy, r.y + r.h - p1[1]]];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t0 < t1;
}

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export function gateActions(input: DSLAction[], canvas: CanvasElement[]): GateResult {
  const warnings: string[] = [];
  const live = new Set(canvas.map((e) => e.id));
  const created = new Set<string>();
  const out: DSLAction[] = [];

  for (const raw of input) {
    const result = safeValidateAction(raw);
    if (!result.success) {
      warnings.push(`dropped invalid ${(raw as { action?: string }).action}: ${result.error}`);
      continue;
    }
    let action = result.data as DSLAction;

    if (action.action === "delete_element") {
      if (!live.has(action.elementId) && !created.has(action.elementId)) continue; // nothing to delete
      live.delete(action.elementId);
      created.delete(action.elementId);
    } else if (action.action === "highlight_element" || action.action === "move_element") {
      if (!live.has(action.elementId) && !created.has(action.elementId)) {
        warnings.push(`dropped ${action.action} for unknown element ${action.elementId}`);
        continue;
      }
    } else if ("id" in action) {
      if (created.has(action.id)) {
        warnings.push(`dropped duplicate element id ${action.id}`);
        continue;
      }
      if (action.action === "create_arrow") {
        const exists = (id?: string) => !id || created.has(id) || live.has(id);
        if (!exists(action.fromId) || !exists(action.toId)) {
          // Keep the arrow only if explicit coordinates make it drawable.
          const { fromId, toId, ...rest } = action;
          const repaired = {
            ...rest,
            ...(exists(fromId) ? { fromId } : {}),
            ...(exists(toId) ? { toId } : {}),
          };
          const check = safeValidateAction(repaired);
          if (!check.success) {
            warnings.push(`dropped arrow ${action.id}: endpoint missing and no coordinates`);
            continue;
          }
          warnings.push(`arrow ${action.id}: unbound missing endpoint`);
          action = check.data as DSLAction;
        }
      }
      created.add((action as { id: string }).id);
    }
    out.push(action);
  }

  // Geometry audit of the new shapes (containers holding text are fine).
  const boxes = out.map(boxOf).filter((b): b is Box => b !== null);
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      if (hit && !contains(a, b) && !contains(b, a)) overlaps++;
    }
  }
  if (overlaps) warnings.push(`${overlaps} overlapping shape pair(s) in compiled output`);

  // Connectors must not pass through shapes they don't connect.
  let crossings = 0;
  for (const a of out) {
    if (a.action !== "create_arrow" || a.startX === undefined || a.endX === undefined) continue;
    const pts: Array<[number, number]> = [[a.startX, a.startY!], ...(a.waypoints ?? []), [a.endX, a.endY!]];
    for (const b of boxes) {
      if (b.id === a.fromId || b.id === a.toId) continue;
      const inner = { x: b.x + 4, y: b.y + 4, w: b.w - 8, h: b.h - 8 };
      if (inner.w <= 0 || inner.h <= 0) continue;
      if (pts.some((p, i) => i < pts.length - 1 && segmentCrossesBox(p, pts[i + 1], inner))) crossings++;
    }
  }
  if (crossings) warnings.push(`${crossings} connector(s) cross unrelated shapes`);

  return { actions: out, warnings };
}
