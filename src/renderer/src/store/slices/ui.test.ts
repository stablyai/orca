import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/types'
import { createUISlice } from './ui'
import type { AppState } from '../types'

function createUIStore(): StoreApi<AppState> {
  // Only the UI slice, repo ids, and right sidebar width fallback are needed
  // for persisted UI hydration tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    rightSidebarWidth: 280,
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}

describe('createUISlice hydratePersistedUI', () => {
  it('preserves the current right sidebar width when older persisted UI omits it', () => {
    const store = createUIStore()

    store.setState({ rightSidebarWidth: 360 })
    store.getState().hydratePersistedUI({
      ...makePersistedUI(),
      rightSidebarWidth: undefined as unknown as number
    })

    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('clamps persisted sidebar widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 100,
        rightSidebarWidth: 100
      })
    )

    expect(store.getState().sidebarWidth).toBe(220)
    expect(store.getState().rightSidebarWidth).toBe(220)
  })

  it('preserves right sidebar widths above the former 500px cap', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 260,
        rightSidebarWidth: 900
      })
    )

    // Left sidebar stays capped; right sidebar now allows wide drag targets
    // so long file names remain readable.
    expect(store.getState().sidebarWidth).toBe(260)
    expect(store.getState().rightSidebarWidth).toBe(900)
  })

  it('falls back to existing sidebar widths when persisted values are not finite', () => {
    const store = createUIStore()

    store.getState().setSidebarWidth(320)
    store.setState({ rightSidebarWidth: 360 })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: Number.NaN,
        rightSidebarWidth: Number.POSITIVE_INFINITY
      })
    )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('restores the active-only filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showActiveOnly: true
      })
    )

    expect(store.getState().showActiveOnly).toBe(true)
  })
})

describe('createUISlice settings navigation', () => {
  it('returns to the new workspace page after visiting settings from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openNewWorkspacePage({ preselectedRepoId: 'repo-1' })
    store.getState().openSettingsPage()

    expect(store.getState().activeView).toBe('settings')
    expect(store.getState().previousViewBeforeSettings).toBe('new-workspace')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('new-workspace')
  })

  it('keeps the original return target when settings is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openNewWorkspacePage()
    store.getState().openSettingsPage()
    store.getState().openSettingsPage()

    expect(store.getState().previousViewBeforeSettings).toBe('new-workspace')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('new-workspace')
  })
})
