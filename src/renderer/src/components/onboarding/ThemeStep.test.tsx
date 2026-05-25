import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOnboardingThemeSelection, ThemeStep } from './ThemeStep'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyOnboardingThemeSelection', () => {
  it('previews and persists the selected theme immediately', () => {
    const onThemeChange = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    applyOnboardingThemeSelection('light', onThemeChange, updateSettings)

    expect(onThemeChange).toHaveBeenCalledWith('light')
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'light' })
  })
})

describe('ThemeStep tile counts', () => {
  // Why: each tile button uses this exact class prefix from the component.
  // Counting it gives us a tile count that's robust to selected-state classes.
  const TILE_CLASS_SIGNATURE =
    'group overflow-hidden rounded-xl border p-3 text-left transition-all'

  function countTiles(html: string): number {
    return html.split(TILE_CLASS_SIGNATURE).length - 1
  }

  it('renders 5 theme tiles on macOS', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
    const html = renderToStaticMarkup(
      <ThemeStep theme="system" onThemeChange={vi.fn()} settings={null} updateSettings={vi.fn()} />
    )
    expect(countTiles(html)).toBe(5)
  })

  it('renders 3 theme tiles on non-macOS', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })
    const html = renderToStaticMarkup(
      <ThemeStep theme="system" onThemeChange={vi.fn()} settings={null} updateSettings={vi.fn()} />
    )
    expect(countTiles(html)).toBe(3)
  })
})
