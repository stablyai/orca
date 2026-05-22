import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/components/terminal-pane/shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: vi.fn()
}))

// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: {} }

import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

describe('runtimePaneTitle → sortEpoch', () => {
  it('bumps sortEpoch when the new title classifies differently than the previous title', () => {
    // Why: smart sort's title-heuristic fallback (Edge case 9) reads
    // runtimePaneTitlesByTabId. A hookless agent transitioning from
    // 'working' to 'permission' must trigger a re-sort.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })]
      }
    })
    const before = store.getState().sortEpoch
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠋ Claude')
    const afterWorking = store.getState().sortEpoch
    expect(afterWorking).toBeGreaterThan(before)
    store.getState().setRuntimePaneTitle('tab-1', 1, '✋ Gemini CLI')
    expect(store.getState().sortEpoch).toBeGreaterThan(afterWorking)
  })

  it('does not bump sortEpoch when the classification is unchanged', () => {
    // Why: incidental title noise (spinner frame, prompt suffix) shouldn't
    // churn the sidebar order.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })]
      }
    })
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠋ Claude')
    const baseline = store.getState().sortEpoch
    // Spinner frame change — still classifies as 'working'.
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠙ Claude')
    expect(store.getState().sortEpoch).toBe(baseline)
  })

  it('bumps sortEpoch when clearing a classified title back to none', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })]
      }
    })
    store.getState().setRuntimePaneTitle('tab-1', 1, '✋ Gemini CLI')
    const baseline = store.getState().sortEpoch
    store.getState().clearRuntimePaneTitle('tab-1', 1)
    expect(store.getState().sortEpoch).toBeGreaterThan(baseline)
  })

  it('does not bump sortEpoch when the changing pane belongs to the active worktree (set)', () => {
    // Why: clicking a slept worktree wakes it; the PTY remount briefly
    // reclassifies its title, which must NOT re-rank the active worktree.
    // Stability beats freshness when the user is looking at it.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: 'wt-a', repoId: 'repo1', path: '/path/wt-a' }),
          makeWorktree({ id: 'wt-b', repoId: 'repo1', path: '/path/wt-b' })
        ]
      },
      tabsByWorktree: {
        'wt-a': [makeTab({ id: 'tab-1', worktreeId: 'wt-a' })],
        'wt-b': [makeTab({ id: 'tab-2', worktreeId: 'wt-b' })]
      },
      activeWorktreeId: 'wt-a'
    })
    const baseline = store.getState().sortEpoch
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠋ Claude')
    expect(store.getState().sortEpoch).toBe(baseline)
  })

  it('does not bump sortEpoch when the changing pane belongs to the active worktree (clear)', () => {
    // Why: same no-view-triggered-rerank invariant — when the active worktree's
    // pane title clears (e.g. on PTY remount during wake), the sidebar must
    // not reorder underneath the user's current selection.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: 'wt-a', repoId: 'repo1', path: '/path/wt-a' }),
          makeWorktree({ id: 'wt-b', repoId: 'repo1', path: '/path/wt-b' })
        ]
      },
      tabsByWorktree: {
        'wt-a': [makeTab({ id: 'tab-1', worktreeId: 'wt-a' })],
        'wt-b': [makeTab({ id: 'tab-2', worktreeId: 'wt-b' })]
      },
      activeWorktreeId: 'wt-b'
    })
    // Seed the classified title while wt-a is INACTIVE so the gate doesn't
    // suppress this preparatory write — we only want to test the gate on clear.
    store.getState().setRuntimePaneTitle('tab-1', 1, '✋ Gemini CLI')
    store.setState({ activeWorktreeId: 'wt-a' })
    const baseline = store.getState().sortEpoch
    store.getState().clearRuntimePaneTitle('tab-1', 1)
    expect(store.getState().sortEpoch).toBe(baseline)
  })
})
