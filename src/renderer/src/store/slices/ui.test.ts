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
        rightSidebarWidth: 900
      })
    )

    expect(store.getState().sidebarWidth).toBe(220)
    expect(store.getState().rightSidebarWidth).toBe(500)
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
})
