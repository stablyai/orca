// @vitest-environment happy-dom
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { AppearanceChatSection } from './AppearanceChatSection'

const mock = vi.hoisted(
  (): { state: { settingsSearchQuery: string; settings: GlobalSettings | null } } => ({
    state: { settingsSearchQuery: '', settings: null }
  })
)

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mock.state) => unknown) => selector(mock.state),
    { getState: () => mock.state }
  )
}))
beforeEach(() => {
  mock.state.settings = null
})
afterEach(cleanup)

function persistInMock(settings: GlobalSettings) {
  mock.state.settings = settings
  return vi.fn(async (updates: Partial<GlobalSettings>) => {
    mock.state.settings = { ...mock.state.settings!, ...updates }
  })
}

describe('chat contrast controls', () => {
  it('renders a switch and saves the opt-in choice', async () => {
    const settings = createGlobalSettingsFixture()
    const updateSettings = persistInMock(settings)
    render(<AppearanceChatSection settings={settings} updateSettings={updateSettings} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Match terminal interface' }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        nativeChatAppearance: { matchTerminalInterface: true }
      })
    )
  })

  it('shows the clamped contrast and supports slider keyboard input', async () => {
    const settings = createGlobalSettingsFixture({ nativeChatAppearance: { contrast: 999 } })
    const updateSettings = persistInMock(settings)
    render(<AppearanceChatSection settings={settings} updateSettings={updateSettings} />)
    const slider = screen.getByRole('slider', { name: 'Contrast' })
    expect(slider.getAttribute('aria-valuenow')).toBe('150')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ nativeChatAppearance: { contrast: 149 } })
    )
    expect(screen.getByText('Softer')).toBeTruthy()
    expect(screen.getByText('Sharper')).toBeTruthy()
  })
  it('keeps keyboard focus when a committed value reaches settings', async () => {
    const settings = createGlobalSettingsFixture({ nativeChatAppearance: { contrast: 120 } })
    const updateSettings = persistInMock(settings)
    const { rerender } = render(
      <AppearanceChatSection settings={settings} updateSettings={updateSettings} />
    )
    const slider = screen.getByRole('slider', { name: 'Contrast' })
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ nativeChatAppearance: { contrast: 119 } })
    )
    rerender(
      <AppearanceChatSection
        settings={{ ...settings, nativeChatAppearance: { contrast: 119 } }}
        updateSettings={updateSettings}
      />
    )
    expect(document.activeElement).toBe(slider)
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ nativeChatAppearance: { contrast: 118 } })
    )
  })
})
