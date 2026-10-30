// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { sanitizePluginIconSvg } from './plugin-icon-svg'

// Shapes of real icon-pack files: gradients, clip paths, style attributes and editor metadata.
const GRADIENT_ICON = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 32 32"
     inkscape:version="1.3">
  <defs>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3178c6"/>
      <stop offset="1" style="stop-color:#235a97"/>
    </linearGradient>
    <clipPath id="clip"><rect width="32" height="32" rx="4"/></clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="32" height="32" fill="url(#a)"/>
    <path d="M10 16h12" stroke="#fff" stroke-width="2"/>
  </g>
  <inkscape:grid id="g1"/>
</svg>`

describe('sanitizePluginIconSvg', () => {
  it('keeps multi-color icons with gradients and internal references, and drops editor metadata', () => {
    const icon = sanitizePluginIconSvg(GRADIENT_ICON)
    expect(icon?.monochrome).toBe(false)
    expect(icon?.svg).toContain('url(#a)')
    expect(icon?.svg).toContain('clip-path="url(#clip)"')
    expect(icon?.svg).toContain('stop-color:#235a97')
    expect(icon?.svg).not.toContain('inkscape')
  })

  it('treats an icon drawn only in currentColor as monochrome', () => {
    expect(
      sanitizePluginIconSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1" fill="currentColor" stroke="none"/></svg>'
      )?.monochrome
    ).toBe(true)
    expect(
      sanitizePluginIconSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/><path fill="#f00"/></svg>'
      )?.monochrome
    ).toBe(false)
    // An unpainted shape keeps SVG's default black fill.
    expect(
      sanitizePluginIconSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/><path d="M0 0h1"/></svg>'
      )?.monochrome
    ).toBe(false)
    expect(
      sanitizePluginIconSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path/><path/></svg>'
      )?.monochrome
    ).toBe(true)
    // Stroke-only icons declare fill="none", usually on the root.
    expect(
      sanitizePluginIconSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" fill="none"><path stroke="currentColor"/></svg>'
      )?.monochrome
    ).toBe(true)
  })

  it.each([
    ['script', '<script>alert(1)</script>', 'script'],
    ['foreign content', '<foreignObject><div/></foreignObject>', 'foreignObject'],
    ['a style element', '<style>*{fill:red}</style>', 'style>'],
    ['use', '<use href="#a"/>', 'use'],
    ['an event handler', '<rect onclick="x()"/>', 'onclick'],
    ['an xlink href', '<rect xlink:href="https://evil"/>', 'evil'],
    [
      'any-prefix href',
      '<rect xmlns:x="http://www.w3.org/1999/xlink" x:href="https://evil"/>',
      'evil'
    ],
    ['an external url()', '<rect fill="url(https://evil/x.svg#a)"/>', 'evil'],
    ['a style url()', '<rect style="fill:url(https://evil)"/>', 'evil']
  ])('removes %s', (_label, body, forbidden) => {
    const icon = sanitizePluginIconSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${body}<rect width="1" height="1"/></svg>`
    )
    expect(icon?.svg).toBeDefined()
    expect(icon?.svg).not.toContain(forbidden)
  })

  it('rejects documents that are not one SVG', () => {
    expect(sanitizePluginIconSvg('<html/>')).toBeNull()
    expect(sanitizePluginIconSvg('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')).toBeNull()
  })
})
