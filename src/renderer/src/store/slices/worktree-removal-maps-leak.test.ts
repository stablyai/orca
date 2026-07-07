/**
 * Memory-leak regression: per-worktree and per-page maps that the worktree-removal
 * paths previously missed must be evicted on removal.
 *
 * Two families of entity-keyed Records grew monotonically over a session:
 *
 *  - Worktree-keyed: `remoteStatusesByWorktree`, `recentlyClosedEditorTabsByWorktree`
 *    and `defaultTerminalTabsAppliedByWorktreeId` were re-keyed on rename but absent
 *    from BOTH removal paths (the bulk `buildWorktreePurgeState` and the single
 *    `removeWorktree` reducer), while their siblings (gitStatusByWorktree,
 *    recentlyClosedBrowserTabsByWorktree, …) were purged.
 *  - Page/workspace-keyed browser maps: `browserAnnotationsByPageId`,
 *    `remoteBrowserPageHandlesByPageId`, `pendingAddressBarFocusByPageId`,
 *    `pendingAddressBarFocusByTabId` and `recentlyClosedBrowserPagesByWorkspace`
 *    were cleaned only on the single-worktree path (via shutdownWorktreeBrowsers →
 *    closeBrowserTab); the bulk reconcile path (CLI/SSH/other-window git worktree
 *    removal) skipped them, orphaning entries permanently.
 *
 * worktreeId, browser workspace id and browser page id are all unbounded, ephemeral
 * key spaces (fresh UUIDs / path-derived ids, never reused).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'
import {
  getAgentHibernationPaneOutputEpoch,
  recordAgentHibernationPaneOutput,
  resetAgentHibernationOutputActivityForTests
} from '@/lib/agent-hibernation-output-activity'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import {
  createTestStore,
  seedStore,
  makeWorktree,
  makeOpenFile,
  makeTab
} from './store-test-helpers'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'

function makeWorkspace(id: string, worktreeId: string): BrowserWorkspace {
  return {
    id,
    worktreeId,
    url: 'about:blank',
    title: '',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

function makePage(id: string, workspaceId: string, worktreeId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId,
    url: 'about:blank',
    title: '',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

describe('worktree removal evicts the per-worktree + per-page maps it previously missed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    resetAgentHibernationOutputActivityForTests()
  })

  function seedWorktreeKeyedMaps(store: ReturnType<typeof createTestStore>): void {
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      remoteStatusesByWorktree: {
        [WT1]: { hasUpstream: true, ahead: 1, behind: 0 },
        [WT2]: { hasUpstream: true, ahead: 0, behind: 2 }
      },
      recentlyClosedEditorTabsByWorktree: {
        [WT1]: [makeOpenFile({ id: '/path/wt1/closed.ts', worktreeId: WT1 })],
        [WT2]: [makeOpenFile({ id: '/path/wt2/closed.ts', worktreeId: WT2 })]
      },
      defaultTerminalTabsAppliedByWorktreeId: { [WT1]: true, [WT2]: true }
    })
  }

  it('bulk purgeWorktreeTerminalState drops worktree-keyed maps for the removed worktree only', () => {
    const store = createTestStore()
    seedWorktreeKeyedMaps(store)

    store.getState().purgeWorktreeTerminalState([WT1])

    const s = store.getState()
    // Evicted for the removed worktree.
    expect(s.remoteStatusesByWorktree[WT1]).toBeUndefined()
    expect(s.recentlyClosedEditorTabsByWorktree[WT1]).toBeUndefined()
    expect(s.defaultTerminalTabsAppliedByWorktreeId[WT1]).toBeUndefined()
    // Retained for the surviving worktree (guard over-eviction).
    expect(s.remoteStatusesByWorktree[WT2]).toBeDefined()
    expect(s.recentlyClosedEditorTabsByWorktree[WT2]).toBeDefined()
    expect(s.defaultTerminalTabsAppliedByWorktreeId[WT2]).toBe(true)
  })

  it('single removeWorktree drops worktree-keyed maps for the removed worktree only', async () => {
    const store = createTestStore()
    seedWorktreeKeyedMaps(store)

    const result = await store.getState().removeWorktree(WT1)
    expect(result).toEqual({ ok: true })

    const s = store.getState()
    expect(s.remoteStatusesByWorktree[WT1]).toBeUndefined()
    expect(s.recentlyClosedEditorTabsByWorktree[WT1]).toBeUndefined()
    expect(s.defaultTerminalTabsAppliedByWorktreeId[WT1]).toBeUndefined()
    expect(s.remoteStatusesByWorktree[WT2]).toBeDefined()
    expect(s.recentlyClosedEditorTabsByWorktree[WT2]).toBeDefined()
    expect(s.defaultTerminalTabsAppliedByWorktreeId[WT2]).toBe(true)
  })

  it('worktree removal drops the hibernation output-epoch map for the removed worktree only', () => {
    const store = createTestStore()
    const LEAF = '11111111-1111-4111-8111-111111111111'
    const TAB1 = 'tab-wt1'
    const TAB2 = 'tab-wt2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
        [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
      }
    })
    const removedPaneKey = `${TAB1}:${LEAF}`
    const survivingPaneKey = `${TAB2}:${LEAF}`
    recordAgentHibernationPaneOutput(removedPaneKey)
    recordAgentHibernationPaneOutput(survivingPaneKey)

    store.getState().purgeWorktreeTerminalState([WT1])

    // Removed worktree's pane reads back as never-seen (epoch 0).
    expect(getAgentHibernationPaneOutputEpoch(removedPaneKey)).toBe(0)
    // Surviving worktree's pane keeps its epoch (guard over-eviction).
    expect(getAgentHibernationPaneOutputEpoch(survivingPaneKey)).toBe(1)
  })

  it('bulk purgeWorktreeTerminalState drops native-chat launch prompts for removed tabs only', () => {
    const store = createTestStore()
    const TAB1 = 'tab-wt1'
    const TAB2 = 'tab-wt2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
        [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
      },
      nativeChatLaunchPromptByTabId: {
        [TAB1]: { tabId: TAB1, agent: 'codex', text: 'fix wt1', createdAt: 1 },
        [TAB2]: { tabId: TAB2, agent: 'codex', text: 'fix wt2', createdAt: 2 }
      }
    })

    store.getState().purgeWorktreeTerminalState([WT1])

    const s = store.getState()
    expect(s.nativeChatLaunchPromptByTabId[TAB1]).toBeUndefined()
    expect(s.nativeChatLaunchPromptByTabId[TAB2]).toEqual({
      tabId: TAB2,
      agent: 'codex',
      text: 'fix wt2',
      createdAt: 2
    })
  })

  it('single removeWorktree drops native-chat launch prompts for removed tabs only', async () => {
    const store = createTestStore()
    const TAB1 = 'tab-wt1'
    const TAB2 = 'tab-wt2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
        [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
      },
      nativeChatLaunchPromptByTabId: {
        [TAB1]: { tabId: TAB1, agent: 'claude', text: 'fix wt1', createdAt: 1 },
        [TAB2]: { tabId: TAB2, agent: 'claude', text: 'fix wt2', createdAt: 2 }
      }
    })

    const result = await store.getState().removeWorktree(WT1)

    expect(result).toEqual({ ok: true })
    const s = store.getState()
    expect(s.nativeChatLaunchPromptByTabId[TAB1]).toBeUndefined()
    expect(s.nativeChatLaunchPromptByTabId[TAB2]).toEqual({
      tabId: TAB2,
      agent: 'claude',
      text: 'fix wt2',
      createdAt: 2
    })
  })

  it('bulk purgeWorktreeTerminalState drops page/workspace-keyed browser maps for the removed worktree only', () => {
    const store = createTestStore()
    const WS1 = 'ws-1'
    const WS2 = 'ws-2'
    const P1 = 'page-1'
    const P2 = 'page-2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      browserTabsByWorktree: {
        [WT1]: [makeWorkspace(WS1, WT1)],
        [WT2]: [makeWorkspace(WS2, WT2)]
      },
      browserPagesByWorkspace: {
        [WS1]: [makePage(P1, WS1, WT1)],
        [WS2]: [makePage(P2, WS2, WT2)]
      },
      browserAnnotationsByPageId: { [P1]: [], [P2]: [] },
      remoteBrowserPageHandlesByPageId: {
        [P1]: { environmentId: 'env-1', remotePageId: 'r-1' },
        [P2]: { environmentId: 'env-2', remotePageId: 'r-2' }
      },
      pendingAddressBarFocusByPageId: { [P1]: true, [P2]: true },
      // createBrowserTab writes BOTH the workspace id and the page id here.
      pendingAddressBarFocusByTabId: { [WS1]: true, [P1]: true, [WS2]: true, [P2]: true },
      recentlyClosedBrowserPagesByWorkspace: {
        [WS1]: [makePage(P1, WS1, WT1)],
        [WS2]: [makePage(P2, WS2, WT2)]
      }
    })

    store.getState().purgeWorktreeTerminalState([WT1])

    const s = store.getState()
    // Removed worktree's workspace + page entries are gone.
    expect(s.browserAnnotationsByPageId[P1]).toBeUndefined()
    expect(s.remoteBrowserPageHandlesByPageId[P1]).toBeUndefined()
    expect(s.pendingAddressBarFocusByPageId[P1]).toBeUndefined()
    expect(s.pendingAddressBarFocusByTabId[WS1]).toBeUndefined()
    expect(s.pendingAddressBarFocusByTabId[P1]).toBeUndefined()
    expect(s.recentlyClosedBrowserPagesByWorkspace[WS1]).toBeUndefined()
    // Surviving worktree's entries remain (guard over-eviction).
    expect(s.browserAnnotationsByPageId[P2]).toBeDefined()
    expect(s.remoteBrowserPageHandlesByPageId[P2]).toBeDefined()
    expect(s.pendingAddressBarFocusByPageId[P2]).toBe(true)
    expect(s.pendingAddressBarFocusByTabId[WS2]).toBe(true)
    expect(s.pendingAddressBarFocusByTabId[P2]).toBe(true)
    expect(s.recentlyClosedBrowserPagesByWorkspace[WS2]).toBeDefined()
  })
})
