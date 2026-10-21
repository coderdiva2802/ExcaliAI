// ─────────────────────────────────────────────────────────
// Canvas Container — Excalidraw + formula/code overlays,
// with local persistence so a refresh restores the board.
// ─────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCanvasStore, type CustomOverlay } from "../../store/canvasStore";
import { VIEW_BACKGROUND } from "../../engine/CanvasController";
import { FormulaRenderer } from "./renderers/FormulaRenderer";
import { CodeRenderer } from "./renderers/CodeRenderer";

const SCENE_KEY = "excaliai.scene.v2";
const SAVE_DEBOUNCE_MS = 700;

interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

interface SavedScene {
  elements: unknown[];
  overlays: CustomOverlay[];
}

function loadScene(): SavedScene | null {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    return raw ? (JSON.parse(raw) as SavedScene) : null;
  } catch {
    return null;
  }
}

export function clearSavedScene(): void {
  try {
    localStorage.removeItem(SCENE_KEY);
  } catch {
    /* ignore */
  }
}

interface CanvasContainerProps {
  onAPIReady: (api: ExcalidrawImperativeAPI) => void;
}

export const CanvasContainer = memo(function CanvasContainer({ onAPIReady }: CanvasContainerProps) {
  const overlays = useCanvasStore((s) => s.overlays);
  const [viewport, setViewport] = useState<Viewport>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const viewportRef = useRef(viewport);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const latestElements = useRef<readonly unknown[]>([]);

  // Restore once, synchronously, before Excalidraw mounts.
  const initialData = useMemo(() => {
    const saved = loadScene();
    if (saved?.overlays?.length) useCanvasStore.getState().setOverlays(saved.overlays);
    return {
      elements: (saved?.elements ?? []) as any,
      appState: { theme: "dark" as const, viewBackgroundColor: VIEW_BACKGROUND },
      scrollToContent: true,
    };
  }, []);

  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current);
    try {
      const data: SavedScene = {
        elements: latestElements.current.filter((e: any) => !e.isDeleted),
        overlays: useCanvasStore.getState().overlays,
      };
      localStorage.setItem(SCENE_KEY, JSON.stringify(data));
    } catch {
      /* storage full or unavailable — persistence is best-effort */
    }
  }, []);

  const persist = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }, [saveNow]);

  // Never lose the last changes to the debounce: flush when the tab is hidden or closed.
  useEffect(() => {
    const onHide = () => saveNow();
    const onVisibility = () => document.visibilityState === "hidden" && saveNow();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [saveNow]);

  // Overlays live outside Excalidraw, so persist when they change too.
  useEffect(() => persist(), [overlays, persist]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const handleChange = useCallback(
    (elements: readonly unknown[], state: { scrollX: number; scrollY: number; zoom: { value: number } }) => {
      latestElements.current = elements;
      persist();
      // Only re-render overlays when the camera actually moved.
      const v = viewportRef.current;
      if (v.scrollX !== state.scrollX || v.scrollY !== state.scrollY || v.zoom !== state.zoom.value) {
        const next = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
        viewportRef.current = next;
        setViewport(next);
      }
    },
    [persist]
  );

  return (
    <div className="absolute inset-0">
      <Excalidraw
        excalidrawAPI={onAPIReady}
        initialData={initialData}
        onChange={handleChange as any}
        theme="dark"
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            clearCanvas: false,
          },
          tools: { image: false },
        }}
      />

      {/* Formula / code overlays, positioned in canvas space */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {overlays.map((o) => (
          <div
            key={o.id}
            className="absolute"
            style={{
              left: (o.x + viewport.scrollX) * viewport.zoom,
              top: (o.y + viewport.scrollY) * viewport.zoom,
              transform: `scale(${viewport.zoom})`,
              transformOrigin: "top left",
              zIndex: 2,
            }}
          >
            {o.type === "formula" ? (
              <FormulaRenderer latex={o.latex ?? ""} fontSize={o.fontSize} highlighted={o.highlighted} highlightColor={o.highlightColor} />
            ) : (
              <CodeRenderer code={o.code ?? ""} language={o.language ?? "text"} width={o.width} highlighted={o.highlighted} highlightColor={o.highlightColor} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
