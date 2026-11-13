import { describe, expect, it } from 'vitest'
import { parsePluginAppThemeArtifact } from './plugin-theme-artifact'

const parseApp = (value: unknown) => () =>
  parsePluginAppThemeArtifact(JSON.stringify(value), 'strict')

describe('plugin app theme artifacts', () => {
  it('reads a background image, strict for authors and never fatal at runtime', () => {
    const base = { base: 'dark', tokens: { '--background': '#000', '--foreground': '#fff' } }
    const background = { path: 'images/dusk.webp', opacity: 0.35, size: 'tile' }
    const runtime = (value: unknown) =>
      parsePluginAppThemeArtifact(JSON.stringify({ ...base, background: value })).background
    expect(parseApp({ ...base, background })().background).toEqual(background)
    expect(parseApp({ ...base, background: { path: 'a.png', blur: 4 } })).toThrow()
    expect(runtime({ path: 'a.png', blur: 4 })).toEqual({ path: 'a.png' })
    // A newer or out-of-range style value falls back to its default; only a bad path drops the image.
    expect(parseApp({ ...base, background: { path: 'a.png', size: 'stretch' } })).toThrow()
    expect(runtime({ path: 'a.png', size: 'stretch', opacity: 2 })).toMatchObject({ path: 'a.png' })
    expect(parseApp({ ...base, background: { path: '../escape.png' } })).toThrow()
    expect(runtime({ path: '../escape.png' })).toBeUndefined()
  })

  it('reads VS Code-shaped tokenColors, strict for authors and tolerant at runtime', () => {
    const base = { base: 'dark', tokens: { '--background': '#000', '--foreground': '#fff' } }
    const keyword = { name: 'Keywords', scope: ['keyword'], settings: { foreground: '#ff79c6' } }
    expect(parseApp({ ...base, tokenColors: [keyword] })().tokenColors).toEqual([keyword])
    expect(
      parseApp({ ...base, tokenColors: [{ scope: 'x', settings: { foreground: 'red' } }] })
    ).toThrow()
    expect(
      parseApp({ ...base, tokenColors: [{ scope: 'x', settings: { fontStyle: 'wavy' } }] })
    ).toThrow()
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          ...base,
          tokenColors: [
            { ...keyword, settings: { ...keyword.settings, background: '#000' } },
            { scope: 'x', settings: { foreground: 'red' } },
            'junk'
          ]
        })
      ).tokenColors
    ).toEqual([{ scope: ['keyword'], settings: { foreground: '#ff79c6' } }])
  })
})
