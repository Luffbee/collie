import { fromHtml } from "hast-util-from-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { renderToString } from "katex";
import { useMemo, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { MAX_MATH_CHARS } from "@/lib/markdown-math";

/**
 * Only KaTeX's generated markup enters this parser, never Markdown or user HTML. `trust: false`
 * disables URL/HTML extensions. The generated tree becomes React elements and text nodes: no DOM
 * HTML sink, auto-render mutation, or private KaTeX API. MathML supplies the accessible reading.
 */
function typeset(text: string, display: boolean): ReactNode | null {
  if (text.length > MAX_MATH_CHARS) return null;
  try {
    const markup = renderToString(text, {
      displayMode: display,
      output: "htmlAndMathml",
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
      // A definition in one equation must not change a later message's meaning.
      macros: {},
    });
    return toJsxRuntime(fromHtml(markup, { fragment: true }), { Fragment, jsx, jsxs });
  } catch {
    // Errors may contain raw input too. Show the original source through React, never an error's HTML.
    return null;
  }
}

/** Shared inline/display math. The caller owns its source, search query and any Copy control. */
export function MathText({
  text,
  source,
  display = false,
  highlighted = false,
}: {
  text: string;
  source: string;
  display?: boolean;
  highlighted?: boolean;
}) {
  const content = useMemo(() => typeset(text, display), [text, display]);
  const Tag = highlighted ? "mark" : "span";
  return (
    <Tag
      data-slot="math"
      className={`${display ? "math-display" : "math-inline"} ${highlighted ? "rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40" : ""}`}
    >
      {content ?? <span className="whitespace-pre-wrap font-mono text-[0.9em]">{source}</span>}
    </Tag>
  );
}
