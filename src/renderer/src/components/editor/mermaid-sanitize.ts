import type { Config } from 'dompurify'
import DOMPurify from 'dompurify'

// Why: match mermaid's own post-render DOMPurify options (mermaid.core.mjs).
// HTML_INTEGRATION_POINTS.foreignobject (lowercase) is required so XHTML label
// children survive Chromium's namespace checks; without it foreignObject is
// emptied (#12414 / #659). ADD_TAGS lowercase matches mermaid's DOMPURIFY_TAGS.
export const mermaidSvgSanitizeConfig: Config = {
  ADD_TAGS: ['foreignobject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }
}

export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, mermaidSvgSanitizeConfig)
}
