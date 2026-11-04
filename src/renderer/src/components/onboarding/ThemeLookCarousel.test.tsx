// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildThemeLooks } from './onboarding-theme-looks'
import { THEME_PLUGINS_URL, ThemeLookCarousel } from './ThemeLookCarousel'

const openUrl = vi.fn()
const looks = buildThemeLooks({
  base: 'dark',
  pluginThemes: [],
  pluginTerminalThemes: [],
  baseline: getDefaultSettings('/tmp'),
  labels: { orca: 'Orca', community: 'Terminal palette', builtIn: () => 'Orca Dark' }
})

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
})

afterEach(cleanup)

function renderCarousel(onPick = vi.fn()): void {
  render(
    <ThemeLookCarousel
      looks={looks}
      selectedId={looks[0].id}
      onPick={onPick}
      ariaLabel="Dark looks"
      header={null}
    />
  )
}

describe('ThemeLookCarousel', () => {
  it('opens the themes plugin directory in the system browser', () => {
    renderCarousel()
    fireEvent.click(screen.getByRole('button', { name: /More themes/ }))
    expect(openUrl).toHaveBeenCalledWith(THEME_PLUGINS_URL)
    expect(new URL(THEME_PLUGINS_URL).searchParams.get('kind')).toBe('themes')
  })

  it('moves focus with arrow keys and applies the focused look on click', () => {
    const onPick = vi.fn()
    renderCarousel(onPick)
    const cards = [
      ...screen
        .getByRole('group', { name: 'Dark looks' })
        .querySelectorAll<HTMLElement>('[data-theme-look]')
    ]
    cards[0].focus()
    fireEvent.keyDown(cards[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cards[1])
    fireEvent.keyDown(cards[1], { key: 'End' })
    const last = cards.at(-1)!
    expect(document.activeElement).toBe(last)
    fireEvent.click(last)
    expect(onPick).toHaveBeenCalledWith(looks.at(-1))
  })
})
