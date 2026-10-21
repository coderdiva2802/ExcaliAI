// ─────────────────────────────────────────────────────────
// Code Renderer — code block overlay on the canvas.
// Rendered as plain text (React escapes it), never as HTML.
// ─────────────────────────────────────────────────────────

import { memo } from "react";

interface CodeRendererProps {
  code: string;
  language: string;
  width?: number;
  highlighted?: boolean;
  highlightColor?: string;
}

export const CodeRenderer = memo(function CodeRenderer({
  code,
  language,
  width = 400,
  highlighted,
  highlightColor = "#fbbf24",
}: CodeRendererProps) {
  return (
    <div
      className="code-overlay animate-fade-in"
      style={{
        width,
        borderColor: highlighted ? highlightColor : undefined,
        boxShadow: highlighted ? `0 0 18px ${highlightColor}55` : undefined,
      }}
    >
      <div className="code-overlay__lang">{language}</div>
      <pre>{code}</pre>
    </div>
  );
});
