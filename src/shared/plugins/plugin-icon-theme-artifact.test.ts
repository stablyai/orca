import { describe, expect, it } from 'vitest'
import {
  parsePluginIconThemeArtifact,
  pluginIconSvgDataUrl,
  validatePluginIconSvg,
  PLUGIN_ICON_SVG_MAX_BYTES,
  PLUGIN_ICON_THEME_MAX_LOOKUP_ENTRIES
} from './plugin-icon-theme-artifact'

const THEME = JSON.stringify({
  iconDefinitions: { ts: 'icons/ts.svg', fallback: 'icons/file.svg' },
  default: 'fallback',
  fileExtensions: { '.TS': 'ts' },
  fileNames: { 'Package.json': 'ts' }
})

describe('parsePluginIconThemeArtifact', () => {
  it('normalizes extension and filename keys for case-insensitive lookup', () => {
    const parsed = parsePluginIconThemeArtifact(THEME)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.artifact.fileExtensions).toEqual({ ts: 'ts' })
    expect(parsed.artifact.fileNames).toEqual({ 'package.json': 'ts' })
    expect(parsed.artifact.defaultIcon).toBe('fallback')
  })

  it.each([
    ['not JSON', '{', 'must contain one JSON object'],
    ['a non-object root', '[]', 'root must be an object'],
    ['missing definitions', '{}', 'requires an iconDefinitions object'],
    [
      'a lookup naming an undeclared definition',
      JSON.stringify({ iconDefinitions: { a: 'a.svg' }, fileExtensions: { ts: 'nope' } }),
      'unknown icon definition'
    ],
    [
      'a default naming an undeclared definition',
      JSON.stringify({ iconDefinitions: { a: 'a.svg' }, default: 'nope' }),
      'default must reference a declared icon definition'
    ],
    [
      'a prototype-polluting definition key',
      // Raw JSON: an object literal would hit JS's `__proto__` setter syntax
      // and never carry the key through JSON.stringify.
      String.raw`{"iconDefinitions":{"__proto__":"a.svg"}}`,
      'iconDefinitions key __proto__ is not safe'
    ],
    [
      'a prototype-polluting lookup key',
      String.raw`{"iconDefinitions":{"a":"a.svg"},"fileNames":{"__proto__":"a"}}`,
      'fileNames key __proto__ is not safe'
    ]
  ])('rejects %s', (_label, raw, message) => {
    const parsed = parsePluginIconThemeArtifact(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.error).toContain(message)
  })

  it('rejects a lookup table past the entry budget', () => {
    const fileExtensions: Record<string, string> = {}
    for (let index = 0; index <= PLUGIN_ICON_THEME_MAX_LOOKUP_ENTRIES; index += 1) {
      fileExtensions[`ext${index}`] = 'a'
    }
    const parsed = parsePluginIconThemeArtifact(
      JSON.stringify({ iconDefinitions: { a: 'a.svg' }, fileExtensions })
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.error).toContain('lookup entries')
  })

  it('does not let a contributed key reach Object.prototype', () => {
    const parsed = parsePluginIconThemeArtifact(
      JSON.stringify({
        iconDefinitions: { a: 'a.svg' },
        fileExtensions: { toString: 'a' }
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    // A plain-object table would resolve `constructor` to the inherited function.
    expect(parsed.artifact.fileExtensions.constructor).toBeUndefined()
    expect(parsed.artifact.fileExtensions.tostring).toBe('a')
  })
})

describe('validatePluginIconSvg', () => {
  it('accepts a plain SVG document', () => {
    expect(validatePluginIconSvg('<svg viewBox="0 0 16 16"><rect/></svg>')).toEqual({ ok: true })
  })

  it.each([
    ['non-SVG content', '<html></html>', 'is not an SVG document'],
    ['script', '<svg ><script>alert(1)</script></svg>', 'script element'],
    ['event handler', '<svg onload="alert(1)"></svg>', 'inline event handler'],
    ['foreignObject', '<svg ><foreignObject/></svg>', 'foreignObject element'],
    ['javascript URL', '<svg ><a href="javascript:alert(1)"/></svg>', 'javascript: URL'],
    ['entity declaration', '<svg ><!ENTITY x "y"></svg>', 'XML entity declaration']
  ])('rejects %s', (_label, svg, message) => {
    const result = validatePluginIconSvg(svg)
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error).toContain(message)
  })
})

describe('pluginIconSvgDataUrl', () => {
  it('round-trips the SVG payload as base64', () => {
    const svg = '<svg viewBox="0 0 16 16"><rect fill="#fff"/></svg>'
    const url = pluginIconSvgDataUrl(svg)
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(url.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(svg)
  })

  // Guards the browser/CLI path, where spreading a full-size icon into
  // String.fromCharCode can exceed the engine argument cap.
  it('encodes an icon at the size ceiling without Buffer', () => {
    const svg = `<svg>${'a'.repeat(PLUGIN_ICON_SVG_MAX_BYTES - 11)}</svg>`
    expect(Buffer.byteLength(svg, 'utf8')).toBe(PLUGIN_ICON_SVG_MAX_BYTES)
    const withBuffer = pluginIconSvgDataUrl(svg)

    const realBuffer = globalThis.Buffer
    // @ts-expect-error -- exercising the branch taken where Buffer is absent
    delete globalThis.Buffer
    try {
      expect(pluginIconSvgDataUrl(svg)).toBe(withBuffer)
    } finally {
      globalThis.Buffer = realBuffer
    }
  })
})
