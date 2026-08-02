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

  it('preserves runtime pane title references when only the spinner frame changes', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })]
      }
    })
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠋ Codex is thinking')
    const runtimePaneTitlesByTabId = store.getState().runtimePaneTitlesByTabId
    const sortEpoch = store.getState().sortEpoch

    store.getState().setRuntimePaneTitle('tab-1', 1, '⠙ Codex is thinking')

    expect(store.getState().runtimePaneTitlesByTabId).toBe(runtimePaneTitlesByTabId)
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe('⠋ Codex is thinking')
    expect(store.getState().sortEpoch).toBe(sortEpoch)
  })

  it('preserves tab map references when only the active pane spinner frame changes', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg', title: 'Terminal 1' })]
      },
      activeWorktreeId: 'wt-bg'
    })
    store.getState().updateTabTitle('tab-1', '⠋ Codex is thinking')
    const tabsByWorktree = store.getState().tabsByWorktree
    const unifiedTabsByWorktree = store.getState().unifiedTabsByWorktree
    const sortEpoch = store.getState().sortEpoch

    store.getState().updateTabTitle('tab-1', '⠙ Codex is thinking')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().unifiedTabsByWorktree).toBe(unifiedTabsByWorktree)
    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe('⠋ Codex is thinking')
    expect(store.getState().sortEpoch).toBe(sortEpoch)
  })

  it.each([
    ['Claude Code', '⠂ Claude Code', '⠐ Claude Code'],
    [
      'Claude task title',
      '⠂ User acknowledgment and confirmation',
      '⠐ User acknowledgment and confirmation'
    ],
    ['Codex', '⠋ Codex is thinking', '⠙ Codex is thinking'],
    ['OpenCode', '⠋ OpenCode running tests', '⠙ OpenCode running tests'],
    ['Aider', '⠋ Aider running', '⠙ Aider running'],
    ['Cursor synthesized title', '⠋ Cursor Agent', '⠙ Cursor Agent'],
    ['Droid synthesized title', '⠋ Droid', '⠙ Droid'],
    ['Hermes synthesized title', '⠋ Hermes', '⠙ Hermes']
  ])('collapses spinner-only title changes for %s', (_label, firstTitle, nextTitle) => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg', title: 'Terminal 1' })]
      }
    })
    store.getState().updateTabTitle('tab-1', firstTitle)
    store.getState().setRuntimePaneTitle('tab-1', 1, firstTitle)
    const tabsByWorktree = store.getState().tabsByWorktree
    const runtimePaneTitlesByTabId = store.getState().runtimePaneTitlesByTabId
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().updateTabTitle('tab-1', nextTitle)
    store.getState().setRuntimePaneTitle('tab-1', 1, nextTitle)

    unsubscribe()
    expect(publications).toBe(0)
    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().runtimePaneTitlesByTabId).toBe(runtimePaneTitlesByTabId)
    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe(firstTitle)
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe(firstTitle)
  })

  it('keeps updating tab titles when the agent status signature changes', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg', title: 'Terminal 1' })]
      },
      activeWorktreeId: 'wt-bg'
    })
    store.getState().updateTabTitle('tab-1', '⠋ Codex is thinking')

    store.getState().updateTabTitle('tab-1', 'Codex ready')

    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe('Codex ready')
  })

  it('keeps updating same-agent titles when the status changes', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg', title: 'Terminal 1' })]
      }
    })
    store.getState().updateTabTitle('tab-1', '⠋ Claude Code')
    store.getState().setRuntimePaneTitle('tab-1', 1, '⠋ Claude Code')
    const baseline = store.getState().sortEpoch

    store.getState().updateTabTitle('tab-1', 'Claude Code - action required')
    store.getState().setRuntimePaneTitle('tab-1', 1, 'Claude Code - action required')

    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe(
      'Claude Code - action required'
    )
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe(
      'Claude Code - action required'
    )
    expect(store.getState().sortEpoch).toBeGreaterThan(baseline)
  })

  it('collapses bulk Codex spinner title churn to the first meaningful publication', () => {
    const store = createTestStore()
    const tabCount = 20
    const worktrees = Array.from({ length: tabCount }, (_, index) =>
      makeWorktree({ id: `wt-${index}`, repoId: 'repo1', path: `/path/wt-${index}` })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )
    seedStore(store, {
      worktreesByRepo: { repo1: worktrees },
      tabsByWorktree
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']

    for (let tabIndex = 0; tabIndex < tabCount; tabIndex += 1) {
      const tabId = `tab-${tabIndex}`
      for (const frame of frames) {
        const title = `${frame} Codex is thinking`
        store.getState().updateTabTitle(tabId, title)
        store.getState().setRuntimePaneTitle(tabId, 1, title)
      }
    }

    unsubscribe()
    expect(publications).toBe(tabCount * 2)
  })

  it('does not enumerate terminal tabs when only the spinner frame changes', () => {
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
    store.setState({
      tabsByWorktree: new Proxy(store.getState().tabsByWorktree, {
        ownKeys() {
          throw new Error('tabsByWorktree should not be enumerated')
        }
      })
    })

    store.getState().setRuntimePaneTitle('tab-1', 1, '⠙ Claude')

    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe('⠋ Claude')
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

  it('does not enumerate terminal tabs when clearing an unclassified title', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-bg', repoId: 'repo1', path: '/path/wt-bg' })]
      },
      tabsByWorktree: {
        'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })]
      }
    })
    store.getState().setRuntimePaneTitle('tab-1', 1, 'shell prompt')
    const baseline = store.getState().sortEpoch
    store.setState({
      tabsByWorktree: new Proxy(store.getState().tabsByWorktree, {
        ownKeys() {
          throw new Error('tabsByWorktree should not be enumerated')
        }
      })
    })

    store.getState().clearRuntimePaneTitle('tab-1', 1)

    expect(store.getState().runtimePaneTitlesByTabId['tab-1']).toBeUndefined()
    expect(store.getState().sortEpoch).toBe(baseline)
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
