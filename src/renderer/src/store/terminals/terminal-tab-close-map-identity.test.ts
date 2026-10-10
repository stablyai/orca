import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const mockApi = createStoreCascadesMockApi()

const WORKTREE = 'repo::/tmp/app'

/** Maps a closing tab has no entry in; closing must not give them a new reference. */
const UNTOUCHED_FIELDS = [
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'runtimePaneTitlesByTabId',
  'lastKnownRelayPtyIdByTabId',
  'deferredSshSessionIdsByTabId',
  'pendingReconnectPtyIdByTabId',
  'directSshPaneRetryByTabId',
  'directSshLivePtyBindingByTabId',
  'pendingStartupByTabId',
  'automaticAgentResumeClaimsByTabId',
  'nativeChatLaunchPromptByTabId',
  'nativeChatLaunchDraftByTabId',
  'pendingInitialCwdByTabId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'expandedPaneByTabId',
  'canExpandPaneByTabId',
  'cacheTimerByKey',
  'lastTerminalInputAtByPaneKey',
  'unreadTerminalTabs',
  'unreadTerminalPanes',
  'unreadAgentCompletionPanes',
  'tabBarOrderByWorktree'
] as const

function storeWithTwoTabs(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ id: 'repo', path: '/tmp/app', name: 'app' }] as never,
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE, repoId: 'repo', path: '/tmp/app' })]
    },
    tabsByWorktree: {
      [WORKTREE]: [
        makeTab({ id: 'tab-a', worktreeId: WORKTREE }),
        makeTab({ id: 'tab-b', worktreeId: WORKTREE })
      ]
    }
  })
  return store
}

describe('closeTab map identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('keeps the reference of every per-tab map the closing tab had no entry in', () => {
    const store = storeWithTwoTabs()
    const before = store.getState()
    const snapshot = Object.fromEntries(
      UNTOUCHED_FIELDS.map((field) => [field, before[field]])
    ) as Record<string, unknown>

    store.getState().closeTab('tab-a')

    const after = store.getState()
    // The tab really closed — otherwise the identity assertions below are vacuous.
    expect(after.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['tab-b'])
    for (const field of UNTOUCHED_FIELDS) {
      expect(after[field], field).toBe(snapshot[field])
    }
  })

  it('still drops the closing tab from a map that did hold it', () => {
    const store = storeWithTwoTabs()
    store.setState({
      expandedPaneByTabId: { 'tab-a': true, 'tab-b': false },
      pendingStartupByTabId: { 'tab-a': true },
      cacheTimerByKey: { 'tab-a:leaf': 1, 'tab-b:leaf': 2 },
      unreadTerminalPanes: { 'tab-a:leaf': true }
    } as never)
    const before = store.getState()

    store.getState().closeTab('tab-a')

    const after = store.getState()
    expect(after.expandedPaneByTabId).not.toBe(before.expandedPaneByTabId)
    expect(after.expandedPaneByTabId).toEqual({ 'tab-b': false })
    expect(after.pendingStartupByTabId).toEqual({})
    expect(after.cacheTimerByKey).toEqual({ 'tab-b:leaf': 2 })
    expect(after.unreadTerminalPanes).toEqual({})
  })
})
