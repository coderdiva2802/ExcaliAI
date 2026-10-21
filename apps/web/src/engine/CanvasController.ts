// ─────────────────────────────────────────────────────────
// Canvas Controller — maps validated DSL actions → Excalidraw.
//
// Identity: every generated element carries its stable DSL id
// (and diagram id) in Excalidraw's `customData`, so lookups
// survive refreshes, undo and user edits — there is no
// separate id map to drift out of sync.
//
// Colors arrive in light-theme space; Excalidraw's dark theme
// inverts the canvas, so the view background is white here
// and renders as near-black on screen.
// ─────────────────────────────────────────────────────────

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type {
  CanvasElement,
  CanvasElementType,
  CanvasState,
  CreateArrowAction,
  CreateCodeAction,
  CreateFormulaAction,
  CreateLineAction,
  CreatePathAction,
  CreateTextAction,
  DSLAction,
  DSLFontFamily,
  DSLStrokeStyle,
  UpdateElementAction,
} from "@excaliai/shared";
import { useCanvasStore, type CustomOverlay } from "../store/canvasStore";

type API = ExcalidrawImperativeAPI;
// Excalidraw element objects are treated structurally here.
type El = Record<string, any>;

/** Background in light space → renders as ~#121212 under the dark-theme filter. */
export const VIEW_BACKGROUND = "#ffffff";
const DEFAULT_STROKE = "#1e1e1e";
const FONT: Record<DSLFontFamily, number> = { sketch: 5, clean: 6, mono: 3 };
const FONT_NAME: Record<number, string> = { 5: "Excalifont", 6: "Nunito", 3: "Cascadia" };
const GLYPH_LOAD_TIMEOUT_MS = 1500;
const MAX_SERIALIZED = 3000;
const MIN_READABLE_ZOOM = 0.6;

let measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, fontSize: number, fontFamily: number, lineHeight: number): { width: number; height: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const lines = text.split("\n");
  if (!measureCtx) return { width: text.length * fontSize * 0.6, height: lines.length * fontSize * lineHeight };
  measureCtx.font = `${fontSize}px ${FONT_NAME[fontFamily] ?? "Excalifont"}`;
  return {
    width: Math.ceil(Math.max(...lines.map((l) => measureCtx!.measureText(l).width))),
    height: Math.ceil(lines.length * fontSize * lineHeight),
  };
}

const groupFor = (diagramId?: string) => (diagramId ? [`grp-${diagramId}`] : []);
const dslIdOf = (el: El): string => el.customData?.dslId ?? el.id;
const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export class CanvasController {
  private api: API | null = null;
  private insets: ViewportInsets = { top: 80, right: 0, bottom: 140, left: 0 };
  private animation = 0;
  private loadedGlyphs = new Set<string>();

  setAPI(api: API): void {
    this.api = api;
  }

  /** Screen areas covered by floating UI, so focus centers on the visible canvas. */
  setViewportInsets(insets: Partial<ViewportInsets>): void {
    this.insets = { ...this.insets, ...insets };
  }

  get ready(): boolean {
    return this.api !== null;
  }

  // ── Dispatch ─────────────────────────────────────────

  /**
   * Excalidraw measures text when an element is created and clips glyphs to that
   * width.  Its fonts are split into unicode-range subsets, so characters outside
   * the already-loaded subset (e.g. "‑", "≤", "→") would be measured with a
   * fallback font.  Load exactly the glyphs this action needs first.
   */
  private async ensureGlyphs(action: DSLAction): Promise<void> {
    const text =
      action.action === "create_text" ? action.text : "label" in action && typeof action.label === "string" ? action.label : "";
    if (!text || typeof document === "undefined" || !document.fonts) return;
    const family = FONT_NAME[action.action === "create_text" ? FONT[action.fontFamily ?? "sketch"] : FONT.sketch];
    const missing = [...new Set(text)].filter((ch) => !this.loadedGlyphs.has(`${family}:${ch}`)).join("");
    if (!missing) return;
    try {
      await Promise.race([document.fonts.load(`20px "${family}"`, missing), new Promise((r) => setTimeout(r, GLYPH_LOAD_TIMEOUT_MS))]);
    } catch {
      /* fall back to whatever is loaded */
    }
    for (const ch of missing) this.loadedGlyphs.add(`${family}:${ch}`);
  }

  async executeAction(action: DSLAction): Promise<void> {
    if (!this.api) return;
    await this.ensureGlyphs(action);
    switch (action.action) {
      case "create_text":
        return this.createText(action);
      case "create_rectangle":
        return this.createShape("rectangle", action, action.rounded);
      case "create_circle":
        return this.createShape("ellipse", action);
      case "create_diamond":
        return this.createShape("diamond", action);
      case "create_arrow":
        return this.createArrow(action);
      case "create_line":
        return this.createLine(action);
      case "create_path":
        return this.createPath(action);
      case "update_element":
        return this.updateElement(action);
      case "create_formula":
      case "create_code":
        return this.createOverlay(action);
      case "highlight_element":
        return this.highlight(action.elementId, action.color ?? "#e67700");
      case "move_element":
        return this.move(action.elementId, action.x, action.y);
      case "delete_element":
        return this.remove(action.elementId);
      case "pan_to":
        return this.panTo(action.x, action.y, action.zoom);
      case "focus_diagram":
        return this.focusDiagram(action.diagramId);
      default:
        // narrate / ask_user / wait are handled by the ActionEngine.
        return;
    }
  }

  // ── Scene helpers ────────────────────────────────────

  private scene(): El[] {
    return (this.api?.getSceneElements() ?? []) as unknown as El[];
  }

  private commit(elements: El[]): void {
    this.api?.updateScene({ elements: elements as any });
  }

  private findByDslId(dslId: string): El | undefined {
    return this.scene().find((el) => dslIdOf(el) === dslId);
  }

  /** Replace-on-create: an id that already exists is removed first (no duplicates, no orphans). */
  private add(converted: El[], dslId: string, diagramId?: string): void {
    this.remove(dslId);
    const groupIds = groupFor(diagramId);
    for (const el of converted) {
      el.groupIds = groupIds;
      if (!el.containerId) el.customData = { dslId, ...(diagramId ? { diagramId } : {}) };
    }
    this.commit([...this.scene(), ...converted]);
  }

  private convert(skeleton: El): El[] {
    return convertToExcalidrawElements([skeleton as any], { regenerateIds: true }) as unknown as El[];
  }

  private label(text: string, color: string | undefined, fontSize: number) {
    return { text, fontSize, fontFamily: FONT.sketch, strokeColor: color ?? DEFAULT_STROKE, textAlign: "center", verticalAlign: "middle" };
  }

  // ── Creation ─────────────────────────────────────────

  private createShape(
    type: "rectangle" | "ellipse" | "diamond",
    a: {
      id: string; diagramId?: string; x: number; y: number; width: number; height: number;
      label?: string; labelColor?: string; labelFontSize?: number;
      strokeColor?: string; backgroundColor?: string; strokeStyle?: DSLStrokeStyle;
    },
    rounded = false
  ): void {
    const fill = a.backgroundColor && a.backgroundColor !== "transparent";
    const skeleton: El = {
      type,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      strokeColor: a.strokeColor ?? DEFAULT_STROKE,
      backgroundColor: a.backgroundColor ?? "transparent",
      fillStyle: fill ? "solid" : "hachure",
      strokeWidth: 2,
      strokeStyle: a.strokeStyle ?? "solid",
      roughness: 1,
      roundness: type === "rectangle" && rounded ? { type: 3 } : type === "diamond" ? { type: 2 } : null,
      ...(a.label ? { label: this.label(a.label, a.labelColor, a.labelFontSize ?? 18) } : {}),
    };
    this.add(this.convert(skeleton), a.id, a.diagramId);
  }

  private createText(a: CreateTextAction): void {
    const skeleton: El = {
      type: "text",
      x: a.x,
      y: a.y,
      text: a.text,
      fontSize: a.fontSize ?? 20,
      fontFamily: FONT[a.fontFamily ?? "sketch"],
      strokeColor: a.color ?? DEFAULT_STROKE,
      textAlign: a.align ?? "left",
    };
    this.add(this.convert(skeleton), a.id, a.diagramId);
  }

  private createLine(a: CreateLineAction): void {
    const dx = a.endX - a.startX;
    const dy = a.endY - a.startY;
    const skeleton: El = {
      type: "line",
      x: a.startX,
      y: a.startY,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [[0, 0], [dx, dy]],
      strokeColor: a.color ?? DEFAULT_STROKE,
      strokeStyle: a.strokeStyle ?? "solid",
      strokeWidth: 1,
      roughness: 0,
    };
    this.add(this.convert(skeleton), a.id, a.diagramId);
  }

  private createArrow(a: CreateArrowAction): void {
    const from = a.fromId ? this.findByDslId(a.fromId) : undefined;
    const to = a.toId ? this.findByDslId(a.toId) : undefined;
    // The server always sends explicit coordinates; centers are only a fallback.
    const center = (el?: El): [number, number] | undefined => (el ? [el.x + el.width / 2, el.y + el.height / 2] : undefined);
    const start = a.startX !== undefined && a.startY !== undefined ? [a.startX, a.startY] : center(from);
    const end = a.endX !== undefined && a.endY !== undefined ? [a.endX, a.endY] : center(to);
    if (!start || !end) {
      console.warn(`Skipping arrow ${a.id}: endpoints unresolved`);
      return;
    }
    const absolute = [start, ...(a.waypoints ?? []), end];
    const points = absolute.map(([x, y]) => [x - start[0], y - start[1]]);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const head = (h?: string) => (h === "none" ? null : h ?? "arrow");
    const skeleton: El = {
      type: "arrow",
      x: start[0],
      y: start[1],
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points,
      strokeColor: a.color ?? DEFAULT_STROKE,
      strokeStyle: a.strokeStyle ?? "solid",
      strokeWidth: 2,
      roughness: 0,
      roundness: a.curved || points.length <= 2 ? { type: 2 } : null,
      startArrowhead: a.startArrowhead ? head(a.startArrowhead) : null,
      endArrowhead: head(a.endArrowhead),
      ...(a.label ? { label: this.label(a.label, a.color, 15) } : {}),
    };
    const converted = this.convert(skeleton);
    const arrow = converted.find((el) => el.type === "arrow");
    this.add(converted, a.id, a.diagramId);
    if (arrow && (from || to)) this.bind(arrow.id, from?.id, to?.id);
  }

  /** Attach an arrow to its shapes so it follows them when the user drags things around. */
  private bind(arrowId: string, fromExcId?: string, toExcId?: string): void {
    const elements = this.scene().map((el) => {
      if (el.id === arrowId) {
        return {
          ...el,
          startBinding: fromExcId ? { elementId: fromExcId, focus: 0, gap: 6 } : null,
          endBinding: toExcId ? { elementId: toExcId, focus: 0, gap: 6 } : null,
          version: el.version + 1,
          versionNonce: randomNonce(),
        };
      }
      if (el.id === fromExcId || el.id === toExcId) {
        const bound = (el.boundElements ?? []).filter((b: El) => b.id !== arrowId);
        return { ...el, boundElements: [...bound, { id: arrowId, type: "arrow" }], version: el.version + 1, versionNonce: randomNonce() };
      }
      return el;
    });
    this.commit(elements);
  }

  /**
   * Multi-point path (plots, axes, polygons, arcs, Venn circles, pie slices).
   * Data visuals use roughness 0 so curves and bars are drawn exactly where computed.
   */
  private createPath(a: CreatePathAction): void {
    const [sx, sy] = a.points[0];
    const points = a.points.map(([x, y]) => [x - sx, y - sy]);
    if (a.closed) points[points.length - 1] = [0, 0]; // Excalidraw fills a line whose ends meet
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const head = (h?: string) => (h === "none" || !h ? null : h);
    const hasHead = !a.closed && Boolean(head(a.startArrowhead) || head(a.endArrowhead));
    const skeleton: El = {
      type: hasHead ? "arrow" : "line",
      x: sx,
      y: sy,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points,
      strokeColor: a.color ?? DEFAULT_STROKE,
      backgroundColor: a.closed && a.backgroundColor ? a.backgroundColor : "transparent",
      fillStyle: "solid",
      strokeWidth: a.strokeWidth ?? 2,
      strokeStyle: a.strokeStyle ?? "solid",
      roughness: 0,
      opacity: a.opacity ?? 100,
      roundness: a.smooth ? { type: 2 } : null,
      startArrowhead: head(a.startArrowhead),
      endArrowhead: head(a.endArrowhead),
    };
    this.add(this.convert(skeleton), a.id, a.diagramId);
  }

  /** Change colors / visibility / label of an existing element in place. */
  private updateElement(a: UpdateElementAction): void {
    const target = this.findByDslId(a.elementId);
    if (!target) return;
    const bump = (el: El, patch: Record<string, unknown>) => ({ ...el, ...patch, version: el.version + 1, versionNonce: randomNonce() });
    this.commit(
      this.scene().map((el) => {
        if (el.id === target.id) {
          return bump(el, {
            ...(a.strokeColor ? { strokeColor: a.strokeColor } : {}),
            ...(a.backgroundColor ? { backgroundColor: a.backgroundColor, fillStyle: "solid" } : {}),
            ...(a.opacity !== undefined ? { opacity: a.opacity } : {}),
          });
        }
        if (el.containerId === target.id) {
          const patch: Record<string, unknown> = a.opacity !== undefined ? { opacity: a.opacity } : {};
          if (a.label !== undefined) {
            // Re-measure so Excalidraw doesn't clip the new text, then re-center it in its container.
            const { width, height } = measureText(a.label, el.fontSize, el.fontFamily, el.lineHeight ?? 1.25);
            Object.assign(patch, {
              text: a.label,
              originalText: a.label,
              width,
              height,
              x: target.x + (target.width - width) / 2,
              y: target.y + (target.height - height) / 2,
            });
          }
          return Object.keys(patch).length ? bump(el, patch) : el;
        }
        return el;
      })
    );
  }

  private createOverlay(a: CreateFormulaAction | CreateCodeAction): void {
    this.remove(a.id);
    const overlay: CustomOverlay =
      a.action === "create_formula"
        ? { id: a.id, diagramId: a.diagramId, type: "formula", x: a.x, y: a.y, latex: a.latex, fontSize: a.fontSize ?? 26, width: a.width, height: a.height }
        : { id: a.id, diagramId: a.diagramId, type: "code", x: a.x, y: a.y, code: a.code, language: a.language, width: a.width ?? 400, height: a.height };
    useCanvasStore.getState().addOverlay(overlay);
  }

  // ── Manipulation ─────────────────────────────────────

  private highlight(dslId: string, color: string): void {
    const store = useCanvasStore.getState();
    if (store.overlays.some((o) => o.id === dslId)) {
      store.updateOverlay(dslId, { highlighted: true, highlightColor: color });
      return;
    }
    const target = this.findByDslId(dslId);
    if (!target) return;
    this.commit(
      this.scene().map((el) =>
        el.id === target.id ? { ...el, strokeColor: color, strokeWidth: 4, version: el.version + 1, versionNonce: randomNonce() } : el
      )
    );
  }

  private move(dslId: string, x: number, y: number): void {
    const store = useCanvasStore.getState();
    if (store.overlays.some((o) => o.id === dslId)) {
      store.updateOverlay(dslId, { x, y });
      return;
    }
    const target = this.findByDslId(dslId);
    if (!target) return;
    const dx = x - target.x;
    const dy = y - target.y;
    this.commit(
      this.scene().map((el) =>
        el.id === target.id || el.containerId === target.id
          ? { ...el, x: el.x + dx, y: el.y + dy, version: el.version + 1, versionNonce: randomNonce() }
          : el
      )
    );
  }

  /** Delete an element together with its bound label. */
  private remove(dslId: string): void {
    const store = useCanvasStore.getState();
    if (store.overlays.some((o) => o.id === dslId)) store.removeOverlay(dslId);
    const scene = this.scene();
    const targets = new Set(scene.filter((el) => dslIdOf(el) === dslId && !el.containerId).map((el) => el.id));
    if (targets.size === 0) return;
    this.commit(
      scene.map((el) =>
        targets.has(el.id) || (el.containerId && targets.has(el.containerId))
          ? { ...el, isDeleted: true, version: el.version + 1, versionNonce: randomNonce() }
          : el
      )
    );
  }

  // ── Viewport ─────────────────────────────────────────

  private viewport() {
    const s = this.api!.getAppState();
    return {
      width: Math.max(200, s.width - this.insets.left - this.insets.right),
      height: Math.max(200, s.height - this.insets.top - this.insets.bottom),
      zoom: s.zoom.value,
      scrollX: s.scrollX,
      scrollY: s.scrollY,
    };
  }

  /** Scroll/zoom so canvas point (cx, cy) sits at the center of the visible area. */
  private target(cx: number, cy: number, zoom: number) {
    const s = this.api!.getAppState();
    const screenCx = this.insets.left + (s.width - this.insets.left - this.insets.right) / 2;
    const screenCy = this.insets.top + (s.height - this.insets.top - this.insets.bottom) / 2;
    return { scrollX: screenCx / zoom - cx, scrollY: screenCy / zoom - cy, zoom };
  }

  private animateTo(goal: { scrollX: number; scrollY: number; zoom: number }, duration = 450): void {
    if (!this.api) return;
    const from = this.viewport();
    const id = ++this.animation;
    const start = performance.now();
    const step = (now: number) => {
      if (id !== this.animation || !this.api) return;
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      this.api.updateScene({
        appState: {
          scrollX: from.scrollX + (goal.scrollX - from.scrollX) * e,
          scrollY: from.scrollY + (goal.scrollY - from.scrollY) * e,
          zoom: { value: from.zoom + (goal.zoom - from.zoom) * e },
        } as any,
      });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private panTo(x: number, y: number, zoom?: number): void {
    if (!this.api) return;
    this.animateTo(this.target(x, y, zoom ?? this.viewport().zoom));
  }

  /** Fit a whole diagram (shapes + formula/code overlays) into the visible area. */
  focusDiagram(diagramId: string): void {
    if (!this.api) return;
    const rects: Array<[number, number, number, number]> = [];
    for (const el of this.scene()) {
      if (el.customData?.diagramId === diagramId) rects.push([el.x, el.y, el.x + el.width, el.y + el.height]);
    }
    for (const o of useCanvasStore.getState().overlays) {
      if (o.diagramId === diagramId) rects.push([o.x, o.y, o.x + (o.width ?? 300), o.y + (o.height ?? 60)]);
    }
    if (!rects.length) return;
    const x0 = Math.min(...rects.map((r) => r[0]));
    const y0 = Math.min(...rects.map((r) => r[1]));
    const x1 = Math.max(...rects.map((r) => r[2]));
    const y1 = Math.max(...rects.map((r) => r[3]));
    const vp = this.viewport();
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // Never zoom out past readability; a diagram that still doesn't fit is
    // anchored at its top-left (title and first steps) instead of centered.
    const zoom = Math.min(1.1, Math.max(MIN_READABLE_ZOOM, 0.9 * Math.min(vp.width / w, vp.height / h)));
    const fitsX = w * zoom <= vp.width;
    const fitsY = h * zoom <= vp.height;
    const centerX = fitsX ? (x0 + x1) / 2 : x0 + vp.width / zoom / 2 - 24 / zoom;
    const centerY = fitsY ? (y0 + y1) / 2 : y0 + vp.height / zoom / 2 - 24 / zoom;
    this.animateTo(this.target(centerX, centerY, zoom));
  }

  // ── Serialization for the AI ─────────────────────────

  serializeForAI(): CanvasState {
    const empty: CanvasState = { elements: [], viewport: { scrollX: 0, scrollY: 0, zoom: 1 } };
    if (!this.api) return empty;
    const scene = this.scene();
    const byExcId = new Map(scene.map((el) => [el.id, el]));
    const labels = new Map<string, string>();
    for (const el of scene) if (el.type === "text" && el.containerId) labels.set(el.containerId, el.text);

    const typeOf = (t: string): CanvasElementType =>
      t === "ellipse" ? "circle" : (["text", "rectangle", "diamond", "arrow", "line", "freedraw"].includes(t) ? t : "other") as CanvasElementType;

    const elements: CanvasElement[] = [];
    for (const el of scene) {
      if (el.containerId || elements.length >= MAX_SERIALIZED) continue;
      const out: CanvasElement = {
        id: dslIdOf(el),
        type: typeOf(el.type),
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
      };
      const text = el.type === "text" ? el.text : labels.get(el.id);
      if (text) out.text = String(text).slice(0, 2000);
      if (el.customData?.diagramId) out.diagramId = el.customData.diagramId;
      const from = el.startBinding?.elementId && byExcId.get(el.startBinding.elementId);
      const to = el.endBinding?.elementId && byExcId.get(el.endBinding.elementId);
      if (from) out.fromId = dslIdOf(from);
      if (to) out.toId = dslIdOf(to);
      elements.push(out);
    }
    for (const o of useCanvasStore.getState().overlays) {
      elements.push({
        id: o.id,
        type: o.type,
        x: Math.round(o.x),
        y: Math.round(o.y),
        width: o.width,
        height: o.height,
        ...(o.latex ? { latex: o.latex } : {}),
        ...(o.code ? { code: o.code.slice(0, 10000), language: o.language } : {}),
        ...(o.diagramId ? { diagramId: o.diagramId } : {}),
      });
    }
    const s = this.api.getAppState();
    return {
      elements,
      viewport: { scrollX: Math.round(s.scrollX), scrollY: Math.round(s.scrollY), zoom: s.zoom.value },
    };
  }

  clear(): void {
    if (this.api) {
      this.api.updateScene({ elements: [] });
      this.api.history.clear();
    }
    useCanvasStore.getState().reset();
  }
}
