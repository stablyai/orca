// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { mermaidSvgSanitizeConfig, sanitizeMermaidSvg } from './mermaid-sanitize'

describe('mermaidSvgSanitizeConfig', () => {
  // Why: Chromium only keeps foreignObject XHTML when these options match
  // mermaid's own post-render sanitize (HTML_INTEGRATION_POINTS + lowercase tags).
  it('matches mermaid post-render DOMPurify options for foreignObject labels', () => {
    expect(mermaidSvgSanitizeConfig.ADD_TAGS).toEqual(['foreignobject'])
    expect(mermaidSvgSanitizeConfig.ADD_ATTR).toEqual(['dominant-baseline'])
    expect(mermaidSvgSanitizeConfig.HTML_INTEGRATION_POINTS).toEqual({ foreignobject: true })
  })
})

describe('sanitizeMermaidSvg', () => {
  it('keeps foreignObject XHTML formatting tags (b/i) that SVG-only profiles strip', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><b>Bold</b> and <i>italic</i></div></foreignObject></g></svg>`
    const out = sanitizeMermaidSvg(svg)
    expect(out).toContain('foreignObject')
    expect(out).toMatch(/<b[\s>]/i)
    expect(out).toMatch(/<i[\s>]/i)
    expect(out).toContain('Bold')
    expect(out).toContain('italic')
  })
})
