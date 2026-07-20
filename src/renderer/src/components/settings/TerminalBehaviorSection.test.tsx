// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { TerminalBehaviorSection } from './TerminalBehaviorSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  document.body.innerHTML = ''
})

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...overrides }
}

describe('TerminalBehaviorSection', () => {
  it('reflects the current terminalAutosuggestEnabled value', () => {
    const markup = renderToStaticMarkup(
      <TerminalBehaviorSection
        settings={makeSettings({ terminalAutosuggestEnabled: false })}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('aria-checked="false"')
  })

  it('calls updateSettings with the toggled value on click', async () => {
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    await act(async () => {
      root.render(
        <TerminalBehaviorSection
          settings={makeSettings({ terminalAutosuggestEnabled: true })}
          updateSettings={updateSettings}
        />
      )
    })

    const switchButton = container.querySelector<HTMLButtonElement>('button[role="switch"]')
    if (!switchButton) {
      throw new Error('Command autosuggest switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ terminalAutosuggestEnabled: false })
    root.unmount()
  })
})
