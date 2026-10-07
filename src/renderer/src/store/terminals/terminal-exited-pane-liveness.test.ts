import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { createTestStore, makeTab, makeWorktree } from '../slices/store-test-helpers'
import { createStoreSessionMockApi } from '../slices/store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createStoreSessionMockApi()

// "Is this pane running" reads the liveness map; an exit leaves the pane's layout binding in place
// for its one stale reattach. The mirror refactor keeps this split: liveness stays in the window,
// the binding becomes main's.

const WORKTREE = 'repo1::/path/wt1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    activeLeafId: LEFT,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
  }
}

function storeWithSplitTab() {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt1', hostId: 'local' })]
    },
    tabsByWorktree: {
      [WORKTREE]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE, ptyId: 'pty-right' })]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
    terminalLayoutsByTabId: { 'tab-1': splitLayout() }
  })
  return store
}

describe('exited pane in a split', () => {
  it('drops only the exited PTY from liveness and keeps every layout binding', () => {
    const store = storeWithSplitTab()

    // Ctrl-D in the left pane.
    store.getState().clearTabPtyId('tab-1', 'pty-left')

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-right'])
    expect(tabHasLivePty(state.ptyIdsByTabId, 'tab-1')).toBe(true)
    expect(state.terminalLayoutsByTabId['tab-1']).toEqual(splitLayout())
  })

  it('reads the tab as not running once both panes exit, with the bindings still saved', () => {
    const store = storeWithSplitTab()

    store.getState().clearTabPtyId('tab-1', 'pty-left')
    store.getState().clearTabPtyId('tab-1', 'pty-right')

    const state = store.getState()
    expect(tabHasLivePty(state.ptyIdsByTabId, 'tab-1')).toBe(false)
    expect(state.tabsByWorktree[WORKTREE]?.[0]?.ptyId).toBeNull()
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEFT]: 'pty-left',
      [RIGHT]: 'pty-right'
    })
  })
})
