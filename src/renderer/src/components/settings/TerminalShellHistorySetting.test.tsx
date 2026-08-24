// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalShellHistorySetting } from './TerminalShellHistorySetting'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, defaultValue: string) => defaultValue
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('TerminalShellHistorySetting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function renderSetting(
    terminalScopeHistoryByWorktree: boolean,
    updateSettings = vi.fn()
  ): HTMLButtonElement {
    act(() => {
      root.render(
        <TerminalShellHistorySetting
          settings={{ terminalScopeHistoryByWorktree } as GlobalSettings}
          updateSettings={updateSettings}
        />
      )
    })
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Scope shell history to each workspace"]'
    )
    if (!toggle) {
      throw new Error('shell history toggle not found')
    }
    return toggle
  }

  it('shows the existing enabled setting and the new-session boundary', () => {
    const toggle = renderSetting(true)

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('Changes apply to new terminal sessions.')
  })

  it('persists the opt-out without changing any other setting', () => {
    const updateSettings = vi.fn()
    const toggle = renderSetting(true, updateSettings)

    act(() => toggle.click())

    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings).toHaveBeenCalledWith({ terminalScopeHistoryByWorktree: false })
  })
})
