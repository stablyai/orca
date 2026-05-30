import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { applyOnboardingThemeSelection, ThemeStep } from './ThemeStep'

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

  it('renders 3 theme tiles (system / dark / light) regardless of platform', () => {
    // Why: glass effect lives in AppearancePane as a separate switch, so
    // onboarding stays at 3 base tiles on every platform.
    const html = renderToStaticMarkup(
      <ThemeStep theme="system" onThemeChange={vi.fn()} settings={null} updateSettings={vi.fn()} />
    )
    expect(countTiles(html)).toBe(3)
  })
})
