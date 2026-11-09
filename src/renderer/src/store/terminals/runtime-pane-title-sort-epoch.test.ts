import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
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

import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'

describe('runtimePaneTitle → sortEpoch', () => {
  it('retains the visible title across a decorative spinner frame', () => {
    const firstTitle = '⠂ Claude Code'
    const nextTitle = '⠐ Claude Code'
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
    store.getState().updateTabTitle('tab-1', nextTitle)
    store.getState().setRuntimePaneTitle('tab-1', 1, nextTitle)

    expect(store.getState().tabsByWorktree['wt-bg']?.[0]?.title).toBe('⠂ Claude Code')
    expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBe('⠂ Claude Code')
  })
})
