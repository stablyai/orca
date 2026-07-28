import { describe, expect, it } from 'vitest'
import { parsePluginIconThemeArtifact, sanitizePluginIconSvg } from './plugin-icon-theme-artifact'

describe('plugin icon theme artifacts', () => {
  it('canonicalizes bounded host slots, file names, and extensions', () => {
    expect(
      parsePluginIconThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          icons: { file: 'icons/file.svg', 'sidebar.search': 'icons/search.svg' },
          fileNames: { 'README.md': 'icons/readme.svg' },
          fileExtensions: { TSX: 'icons/react.svg' }
        })
      )
    ).toEqual({
      icons: { file: 'icons/file.svg', 'sidebar.search': 'icons/search.svg' },
      fileNames: { 'readme.md': 'icons/readme.svg' },
      fileExtensions: { tsx: 'icons/react.svg' }
    })
  })

  it('rejects unknown slots, unsafe paths, and case-insensitive collisions', () => {
    expect(() =>
      parsePluginIconThemeArtifact(
        JSON.stringify({ schemaVersion: 1, icons: { arbitrary: 'icon.svg' } })
      )
    ).toThrow()
    expect(() =>
      parsePluginIconThemeArtifact(
        JSON.stringify({ schemaVersion: 1, fileNames: { README: '../outside.svg' } })
      )
    ).toThrow()
    expect(() =>
      parsePluginIconThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          fileExtensions: { TS: 'one.svg', ts: 'two.svg' }
        })
      )
    ).toThrow(/duplicate case-insensitive/)
  })
})

describe('plugin SVG icon sanitizer', () => {
  it('keeps a passive SVG subset and strips comments', () => {
    expect(
      sanitizePluginIconSvg(
        '<!-- source --><svg viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16z"/></svg>'
      )
    ).toBe('<svg viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16z"/></svg>')
  })

  it.each([
    '<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject><iframe src="https://example.com"/></foreignObject></svg>',
    '<svg onload="alert(1)"><path/></svg>',
    '<svg><image href="https://example.com/pixel"/></svg>',
    '<svg><path style="fill:url(https://example.com/x)"/></svg>',
    '<svg><path style="fill:red"/></svg>',
    '<svg><path fill="&#x75;rl(https://example.com/x)"/></svg>',
    '<svg><path fill="u\\72l(https://example.com/x)"/></svg>',
    '<svg/onload="alert(1)">',
    '<svg><path/></svg><svg/>',
    '<!DOCTYPE svg><svg><path/></svg>'
  ])('rejects active or externally-referencing SVG: %s', (svg) => {
    expect(() => sanitizePluginIconSvg(svg)).toThrow()
  })
})
