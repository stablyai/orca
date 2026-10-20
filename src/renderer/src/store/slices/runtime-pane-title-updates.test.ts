import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
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

describe('runtimePaneTitle updates', () => {
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

    store.getState().setRuntimePaneTitle('tab-1', 1, '⠙ Codex is thinking')

    expect(store.getState().runtimePaneTitlesByTabId).toBe(runtimePaneTitlesByTabId)
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe('⠋ Codex is thinking')
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

    store.getState().updateTabTitle('tab-1', '⠙ Codex is thinking')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().unifiedTabsByWorktree).toBe(unifiedTabsByWorktree)
    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe('⠋ Codex is thinking')
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

    store.getState().updateTabTitle('tab-1', 'Claude Code - action required')
    store.getState().setRuntimePaneTitle('tab-1', 1, 'Claude Code - action required')

    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe(
      'Claude Code - action required'
    )
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe(
      'Claude Code - action required'
    )
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

  it('publishes a bulk tab-title update once across worktrees', () => {
    const store = createTestStore()
    const tabCount = 20
    const worktrees = Array.from({ length: tabCount }, (_, index) =>
      makeWorktree({ id: `wt-${index}`, repoId: 'repo1', path: `/path/wt-${index}` })
    )
    seedStore(store, {
      worktreesByRepo: { repo1: worktrees },
      tabsByWorktree: Object.fromEntries(
        worktrees.map((worktree, index) => [
          worktree.id,
          [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
        ])
      )
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().updateTabTitles(
      worktrees.map((_, index) => ({
        tabId: `tab-${index}`,
        title: `Codex ready ${index}`
      }))
    )

    unsubscribe()
    expect(publications).toBe(1)
    for (let index = 0; index < tabCount; index += 1) {
      expect(store.getState().tabsByWorktree[`wt-${index}`]?.[0]?.title).toBe(
        `Codex ready ${index}`
      )
    }
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
    store.setState({
      tabsByWorktree: new Proxy(store.getState().tabsByWorktree, {
        ownKeys() {
          throw new Error('tabsByWorktree should not be enumerated')
        }
      })
    })

    store.getState().setRuntimePaneTitle('tab-1', 1, '⠙ Claude')

    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe('⠋ Claude')
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
    store.setState({
      tabsByWorktree: new Proxy(store.getState().tabsByWorktree, {
        ownKeys() {
          throw new Error('tabsByWorktree should not be enumerated')
        }
      })
    })

    store.getState().clearRuntimePaneTitle('tab-1', 1)

    expect(store.getState().runtimePaneTitlesByTabId['tab-1']).toBeUndefined()
  })
})
