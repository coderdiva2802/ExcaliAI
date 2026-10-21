// ─────────────────────────────────────────────────────────
// Canvas Store — custom overlays (KaTeX formulas, code blocks)
// that live above the Excalidraw scene.  Excalidraw elements
// themselves are owned by Excalidraw (identity in customData).
// ─────────────────────────────────────────────────────────

import { create } from "zustand";

export interface CustomOverlay {
  id: string;
  diagramId?: string;
  type: "formula" | "code";
  x: number;
  y: number;
  latex?: string;
  code?: string;
  language?: string;
  fontSize?: number;
  width?: number;
  height?: number;
  highlighted?: boolean;
  highlightColor?: string;
}

interface CanvasStoreState {
  overlays: CustomOverlay[];
  addOverlay: (overlay: CustomOverlay) => void;
  removeOverlay: (id: string) => void;
  updateOverlay: (id: string, update: Partial<CustomOverlay>) => void;
  setOverlays: (overlays: CustomOverlay[]) => void;
  reset: () => void;
}

export const useCanvasStore = create<CanvasStoreState>((set) => ({
  overlays: [],
  addOverlay: (overlay) => set((s) => ({ overlays: [...s.overlays.filter((o) => o.id !== overlay.id), overlay] })),
  removeOverlay: (id) => set((s) => ({ overlays: s.overlays.filter((o) => o.id !== id) })),
  updateOverlay: (id, update) => set((s) => ({ overlays: s.overlays.map((o) => (o.id === id ? { ...o, ...update } : o)) })),
  setOverlays: (overlays) => set({ overlays }),
  reset: () => set({ overlays: [] }),
}));
