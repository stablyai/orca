import type { Config } from 'dompurify'
import DOMPurify from 'dompurify'

// XHTML integration keeps labels visible; math labels need MathML, while SVG filters stay excluded.
export const mermaidSvgSanitizeConfig: Config = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  FORBID_TAGS: [
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'datalist',
    'option',
    'optgroup',
    'fieldset',
    'legend',
    'label',
    'output'
  ],
  ADD_TAGS: ['foreignobject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }
}

export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, mermaidSvgSanitizeConfig)
}
