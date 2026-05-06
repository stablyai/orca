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
