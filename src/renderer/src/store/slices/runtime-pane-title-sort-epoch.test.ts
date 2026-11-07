import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/components/terminal-pane/snapshots/shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: vi.fn()
}))

// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: {} }

import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

describe('runtimePaneTitle → sortEpoch', () => {
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
})
