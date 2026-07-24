// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { sanitizeMermaidSvg } from './mermaid-svg-sanitization'

describe('sanitizeMermaidSvg', () => {
  it('keeps required Mermaid SVG styling and filters while removing active content', () => {
    const fragment = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <filter id="shadow"><feDropShadow dx="1" dy="1" /></filter>
        <foreignObject><div onclick="window.__xss = 1">unsafe</div></foreignObject>
        <a href="javascript:window.__xss = 2" target="_blank">
          <text onload="window.__xss = 3">safe label</text>
        </a>
      </svg>
    `)

    expect(fragment.querySelector('filter feDropShadow')).not.toBeNull()
    expect(fragment.querySelector('foreignObject')).toBeNull()
    expect(fragment.querySelector('[onclick], [onload], [target]')).toBeNull()
    expect(fragment.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(fragment.textContent).toContain('safe label')
  })
})
