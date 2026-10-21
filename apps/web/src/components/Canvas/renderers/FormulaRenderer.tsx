// ─────────────────────────────────────────────────────────
// Formula Renderer — KaTeX overlay for LaTeX on the canvas.
// KaTeX escapes its input and `trust: false` blocks \href,
// \url, \htmlClass etc., so LLM-provided LaTeX cannot inject
// markup.  The fallback path renders plain text (no HTML).
// ─────────────────────────────────────────────────────────

import { memo, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
// Chemical equations: \ce{2H2 + O2 -> 2H2O} (KaTeX's mhchem extension, no network or eval).
import "katex/contrib/mhchem";

interface FormulaRendererProps {
  latex: string;
  fontSize?: number;
  highlighted?: boolean;
  highlightColor?: string;
}

export const FormulaRenderer = memo(function FormulaRenderer({
  latex,
  fontSize = 26,
  highlighted,
  highlightColor = "#fbbf24",
}: FormulaRendererProps) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { throwOnError: true, displayMode: true, output: "html", trust: false, strict: "ignore" });
    } catch {
      return null;
    }
  }, [latex]);

  const style = {
    fontSize,
    borderColor: highlighted ? highlightColor : "transparent",
    boxShadow: highlighted ? `0 0 18px ${highlightColor}55` : undefined,
  };

  return html ? (
    <div className="formula-overlay animate-fade-in" style={style} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <div className="formula-overlay formula-overlay--raw animate-fade-in" style={style}>
      {latex}
    </div>
  );
});
