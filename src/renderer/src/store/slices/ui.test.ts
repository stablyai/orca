/* eslint-disable max-lines */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import type { AppState } from '../types'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createUIStore(): StoreApi<AppState> {
  // Only the UI slice, repo ids, and right sidebar width fallback are needed
  // for persisted UI hydration tests. The worktree-nav-history slice is also
  // included because openTaskPage records a Tasks visit via recordViewVisit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    rightSidebarWidth: 280,
    ...createWorktreeNavHistorySlice(...(args as Parameters<typeof createWorktreeNavHistorySlice>)),
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

  it('restores the hide-default-branch filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideDefaultBranchWorkspace: true
      })
    )

    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('hydrates a valid Kagi session link', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://kagi.com/search?token=secret&q=%s'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBe('https://kagi.com/search?token=secret')
  })

  it('drops an invalid Kagi session link during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://example.com/search?token=secret'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBeNull()
  })

  it('hydrates legacy sidekick persisted keys into pet state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        petVisible: undefined,
        petId: undefined,
        petSize: undefined,
        customPets: undefined,
        sidekickVisible: false,
        sidekickId: 'custom-pet',
        sidekickSize: 240,
        customSidekicks: [
          {
            id: 'custom-pet',
            label: 'Legacy pet',
            fileName: 'custom-pet.webp',
            mimeType: 'image/webp',
            kind: 'image'
          }
        ]
      })
    )

    expect(store.getState().petVisible).toBe(false)
    expect(store.getState().petId).toBe('custom-pet')
    expect(store.getState().petSize).toBe(240)
    expect(store.getState().customPets).toEqual([
      {
        id: 'custom-pet',
        label: 'Legacy pet',
        fileName: 'custom-pet.webp',
        mimeType: 'image/webp',
        kind: 'image'
      }
    ])
  })

  it('sanitizes task resume state field-by-field during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        taskResumeState: {
          githubMode: 'project',
          githubItemsPreset: 'invalid',
          githubItemsQuery: 42,
          linearPreset: 'completed',
          linearQuery: 'label:bug'
        } as unknown as PersistedUIState['taskResumeState']
      })
    )

    expect(store.getState().taskResumeState).toEqual({
      githubMode: 'project',
      linearPreset: 'completed',
      linearQuery: 'label:bug'
    })
  })

  it('restores acknowledgedAgentsByPaneKey from persisted UI state', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: { 'tab-a:0': now, 'tab-b:1': now - 5_000 }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 5_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to an empty ack map when persisted UI omits acknowledgedAgentsByPaneKey', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is null', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          null as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is a string', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          'oops' as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is an array', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey: [
          'a',
          'b'
        ] as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('drops non-number / non-finite / non-positive entries from acknowledgedAgentsByPaneKey', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-a:0': now,
            'tab-b:1': now - 1000,
            'tab-c:2': 'not-a-number',
            'tab-d:3': Number.NaN,
            'tab-e:4': Number.POSITIVE_INFINITY,
            'tab-f:5': -1
          } as unknown as Record<string, number>
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 1000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes acknowledgedAgentsByPaneKey entries older than the 7-day TTL during hydration', () => {
    // HYDRATE_MAX_AGE_MS lives in src/renderer/src/store/slices/ui.ts and matches
    // the constant in src/main/agent-hooks/server.ts.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-recent:0': now,
            'tab-old:1': now - SEVEN_DAYS_MS - 1
          }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-recent:0': now
      })
    } finally {
      // The shared afterEach restores mocks/globals but not timers, so clean up
      // here to avoid leaking fake timers into subsequent tests.
      vi.useRealTimers()
    }
  })

  it('drops prototype-pollution keys from acknowledgedAgentsByPaneKey during hydration', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      const malicious: Record<string, number> = {}
      // Object.defineProperty so these land as own enumerable properties rather
      // than getting silently re-routed to Object.prototype by the JS engine.
      Object.defineProperty(malicious, '__proto__', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'constructor', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'prototype', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      malicious['tab-safe:0'] = now

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: malicious
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-safe:0': now
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges and persists partial task resume updates', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ taskResumeState: { githubMode: 'project', linearPreset: 'all' } })
    store.getState().setTaskResumeState({ githubItemsPreset: 'my-prs' })

    const expected = { githubMode: 'project', linearPreset: 'all', githubItemsPreset: 'my-prs' }
    expect(store.getState().taskResumeState).toEqual(expected)
    expect(setUI).toHaveBeenCalledWith({ taskResumeState: expected })
  })
})

describe('createUISlice settings navigation', () => {
  it('returns to the tasks page after visiting settings from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openTaskPage({ preselectedRepoId: 'repo-1' })
    store.getState().openSettingsPage()

    expect(store.getState().activeView).toBe('settings')
    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('keeps the original return target when settings is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openTaskPage()
    store.getState().openSettingsPage()
    store.getState().openSettingsPage()

    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })
})
