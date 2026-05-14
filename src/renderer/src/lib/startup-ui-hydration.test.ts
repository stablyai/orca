import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { PersistedUIState } from '../../../shared/types'
import {
  getStartupErrorFallbackUI,
  hydratePersistedUIAfterStartupRead
} from './startup-ui-hydration'

function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}

describe('startup UI hydration fallback', () => {
  it('does not hydrate default UI after ui.get succeeds and a later session step fails', () => {
    const persistedUI = makePersistedUI({
      sidebarWidth: 444,
      rightSidebarWidth: 777,
      sortBy: 'recent',
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    })
    const hydratePersistedUI = vi.fn<(ui: PersistedUIState) => void>()

    const uiHydrated = hydratePersistedUIAfterStartupRead({
      persistedUI,
      cancelled: false,
      hydratePersistedUI
    })

    // Simulates session.get()/session hydration throwing after ui.get() was
    // already applied. The catch path must not replace the loaded UI with
    // fallback defaults that would then be written back to disk.
    const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
    if (fallbackUI) {
      hydratePersistedUI(fallbackUI)
    }

    expect(hydratePersistedUI).toHaveBeenCalledTimes(1)
    expect(hydratePersistedUI).toHaveBeenCalledWith(persistedUI)
  })

  it('returns fallback defaults when startup fails before persisted UI is hydrated', () => {
    const hydratePersistedUI = vi.fn<(ui: PersistedUIState) => void>()

    const fallbackUI = getStartupErrorFallbackUI(false)
    if (fallbackUI) {
      hydratePersistedUI(fallbackUI)
    }

    expect(hydratePersistedUI).toHaveBeenCalledTimes(1)
    expect(hydratePersistedUI.mock.calls[0][0].sidebarWidth).toBe(280)
    expect(hydratePersistedUI.mock.calls[0][0].sortBy).toBe('name')
  })

  it('does not mark UI hydrated after the startup effect has been cancelled', () => {
    const hydratePersistedUI = vi.fn<(ui: PersistedUIState) => void>()

    const uiHydrated = hydratePersistedUIAfterStartupRead({
      persistedUI: makePersistedUI({ sidebarWidth: 444 }),
      cancelled: true,
      hydratePersistedUI
    })

    expect(uiHydrated).toBe(false)
    expect(hydratePersistedUI).not.toHaveBeenCalled()
  })
})
