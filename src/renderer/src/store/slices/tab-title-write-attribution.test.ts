import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const recordRendererCrashBreadcrumb = vi.fn()
vi.mock('../../lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (...args: unknown[]) => recordRendererCrashBreadcrumb(...args)
}))

// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: {} }

import type { TerminalTab } from '../../../../shared/types'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import {
  _resetTabTitleWriteAttributionBreadcrumbsForTests,
  recordTabTitleWriteWorktreeMismatch
} from './tab-title-write-attribution'

const BREADCRUMB = 'terminal_tab_title_write_worktree_mismatch'
// Real worktree-id shape (`${repoId}::${absolutePath}`) so the repo comparison is exercised.
const WT_A = 'repo1::/path/wt-a'
const WT_B = 'repo1::/path/wt-b'
const WT_OTHER_REPO = 'repo2::/path/other'

function storeWithTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT_A, repoId: 'repo1', path: '/path/wt-a' }),
        makeWorktree({ id: WT_B, repoId: 'repo1', path: '/path/wt-b' })
      ],
      repo2: [makeWorktree({ id: WT_OTHER_REPO, repoId: 'repo2', path: '/path/other' })]
    },
    tabsByWorktree,
    activeWorktreeId: WT_A
  })
  return store
}

function storeWithTabInWorktreeA(): ReturnType<typeof createTestStore> {
  return storeWithTabs({
    [WT_A]: [makeTab({ id: 'tab-1', worktreeId: WT_A, title: 'Terminal 1' })],
    [WT_B]: []
  })
}

beforeEach(() => {
  recordRendererCrashBreadcrumb.mockClear()
  _resetTabTitleWriteAttributionBreadcrumbsForTests()
})

describe('updateTabTitle write attribution', () => {
  it('breadcrumbs a write whose worktree disagrees with the resolved owner', () => {
    const store = storeWithTabInWorktreeA()

    store.getState().updateTabTitle('tab-1', 'Claude Code', {
      worktreeId: WT_B,
      site: 'pty-title-change'
    })

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(BREADCRUMB, {
      tabId: 'tab-1',
      site: 'pty-title-change',
      ownerCount: 1,
      sameRepo: true
    })
    // The write itself must land unchanged.
    expect(store.getState().tabsByWorktree[WT_A]?.[0]?.title).toBe('Claude Code')
  })

  it('stays quiet when the writer agrees with the owner, and when no context is given', () => {
    const store = storeWithTabInWorktreeA()

    store.getState().updateTabTitle('tab-1', 'Claude Code', {
      worktreeId: WT_A,
      site: 'parked-byte-watcher'
    })
    store.getState().updateTabTitle('tab-1', 'Codex ready')

    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[WT_A]?.[0]?.title).toBe('Codex ready')
  })

  // Why: an agent repaints its title continuously, so an unguarded crumb would
  // flood the 30-entry ring and erase everything that led up to the mismatch.
  it('records one crumb per tab/worktree/site combination however often it repeats', () => {
    const store = storeWithTabInWorktreeA()
    const context = { worktreeId: WT_B, site: 'pty-title-change' } as const

    for (let i = 0; i < 5; i += 1) {
      store.getState().updateTabTitle('tab-1', `Claude Code ${i}`, context)
    }

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
  })

  // Why: only a write that lands can misattribute a title; a no-op would otherwise
  // spend the single slot this combination ever gets.
  it('skips a write that leaves the title unchanged and records the one that changes it', () => {
    const store = storeWithTabInWorktreeA()
    const context = { worktreeId: WT_B, site: 'pane-focus-sync' } as const

    store.getState().updateTabTitle('tab-1', 'Terminal 1', context)
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()

    store.getState().updateTabTitle('tab-1', 'Claude Code', context)
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
  })

  // ownerCount is what tells a tab id duplicated across buckets apart from a
  // writer holding a stale worktree id.
  it('counts every worktree bucket holding the tab id', () => {
    const store = storeWithTabs({
      [WT_A]: [makeTab({ id: 'tab-1', worktreeId: WT_A, title: 'Terminal 1' })],
      [WT_B]: [makeTab({ id: 'tab-1', worktreeId: WT_B, title: 'Terminal 1' })]
    })

    // The owner lookup keeps the last bucket seen, so writing as wt-a mismatches.
    store.getState().updateTabTitle('tab-1', 'Claude Code', {
      worktreeId: WT_A,
      site: 'pty-title-change'
    })

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(BREADCRUMB, {
      tabId: 'tab-1',
      site: 'pty-title-change',
      ownerCount: 2,
      sameRepo: true
    })
  })

  it('reports sameRepo false when the writer belongs to another repo', () => {
    const store = storeWithTabInWorktreeA()

    store.getState().updateTabTitle('tab-1', 'Claude Code', {
      worktreeId: WT_OTHER_REPO,
      site: 'ipc-agent-status-title'
    })

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(BREADCRUMB, {
      tabId: 'tab-1',
      site: 'ipc-agent-status-title',
      ownerCount: 1,
      sameRepo: false
    })
  })

  it('stops recording once the unpruned key set hits its cap', () => {
    const tabsByWorktree = { [WT_A]: [] }
    for (let i = 0; i < 256; i += 1) {
      recordTabTitleWriteWorktreeMismatch({
        tabId: `tab-${i}`,
        ownerWorktreeId: WT_A,
        tabsByWorktree,
        context: { worktreeId: WT_B, site: 'pty-title-change' }
      })
    }
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(256)

    recordTabTitleWriteWorktreeMismatch({
      tabId: 'tab-256',
      ownerWorktreeId: WT_A,
      tabsByWorktree,
      context: { worktreeId: WT_B, site: 'pty-title-change' }
    })
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(256)
  })
})
