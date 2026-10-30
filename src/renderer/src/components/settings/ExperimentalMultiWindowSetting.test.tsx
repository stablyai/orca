// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ExperimentalMultiWindowSetting } from './ExperimentalMultiWindowSetting'
import { matchesSettingsSearch } from './settings-search'

const state = vi.hoisted(() => ({ webClient: false }))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => state.webClient
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(cleanup)

it.each([false, true])(
  'offers the host-only switch and its settings search result only on desktop (web: %s)',
  async (webClient) => {
    state.webClient = webClient
    const updateSettings = vi.fn()
    render(
      <ExperimentalMultiWindowSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={updateSettings}
      />
    )

    const control = screen.queryByRole('switch', { name: 'Multiple windows' })
    const { getExperimentalPaneSearchEntries } = await import('./experimental-search')
    expect(matchesSettingsSearch('multiple windows', getExperimentalPaneSearchEntries())).toBe(
      !webClient
    )
    expect(
      matchesSettingsSearch(
        'multiple windows',
        getExperimentalPaneSearchEntries({ isWebClient: !webClient })
      )
    ).toBe(webClient)

    if (webClient) {
      expect(control).toBeNull()
    } else {
      expect(control).not.toBeNull()
      if (!control) {
        throw new Error('Missing Multiple windows switch')
      }
      expect(control.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(control)
      expect(updateSettings).toHaveBeenCalledWith({ experimentalMultiWindow: true })
    }
  }
)
