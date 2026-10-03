import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import { mergeDirectSshRemoteWorkspaceSession } from '@/hooks/remote-workspace-session-merge'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

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

const REMOTE_WORKTREE = 'remote-repo::/srv/app'
const LOCAL_WORKTREE = 'local-repo::/tmp/app'

function storeWithBothWorktrees(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [
      { id: 'remote-repo', path: '/srv/app', name: 'app', connectionId: 'ssh-1' },
      { id: 'local-repo', path: '/tmp/app', name: 'app' }
    ] as never,
    worktreesByRepo: {
      'remote-repo': [
        makeWorktree({ id: REMOTE_WORKTREE, repoId: 'remote-repo', path: '/srv/app' })
      ],
      'local-repo': [makeWorktree({ id: LOCAL_WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    tabsByWorktree: {
      [REMOTE_WORKTREE]: [makeTab({ id: 'remote-tab', worktreeId: REMOTE_WORKTREE })],
      [LOCAL_WORKTREE]: [makeTab({ id: 'local-tab', worktreeId: LOCAL_WORKTREE })]
    }
  })
  return store
}

const closeTerminalSurface = vi.fn()
Object.assign(mockApi, { session: { closeTerminalSurface } })

describe('closeTab close-record mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeTerminalSurface.mockResolvedValue(undefined)
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  // Why every workspace kind: main records every close it is told about, and the mirror is what
  // the seeding predicate reads before the next launch hydrates main's copy.
  it.each([
    ['remote-tab', REMOTE_WORKTREE],
    ['local-tab', LOCAL_WORKTREE]
  ])('mirrors the record main is told to write for %s', (tabId, worktreeId) => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab(tabId)

    expect(store.getState().closedTerminalTabTombstonesByTabId[tabId]).toEqual({
      closedAt: expect.any(Number),
      worktreeId,
      reason: 'user'
    })
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId,
      target: { kind: 'tab', tabId },
      reason: 'user'
    })
  })

  it('mirrors a cleanup close with its reason', () => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab('remote-tab', { reason: 'cleanup' })

    expect(store.getState().closedTerminalTabTombstonesByTabId['remote-tab']?.reason).toBe(
      'cleanup'
    )
  })

  // Main alone closes for a process exit; a paired host owns its own records.
  it.each([
    ['a pty-exit close', { reason: 'pty-exit' as const }],
    ['a host-owned close', { remoteCloseOwnedByHost: true }]
  ])('mirrors nothing for %s', (_label, opts) => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab('remote-tab', opts)

    expect(store.getState().closedTerminalTabTombstonesByTabId).toEqual({})
    expect(closeTerminalSurface).not.toHaveBeenCalled()
  })

  // The race the mirror exists for: a host pull lands after closeTab and before main has answered
  // the close intent (which never resolves here). The host still lists the tab.
  it('keeps a closed SSH tab closed through a pull that lands before main answers', () => {
    closeTerminalSurface.mockReturnValue(new Promise(() => {}))
    const store = storeWithBothWorktrees()
    const hostStillListing = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [REMOTE_WORKTREE]: [makeTab({ id: 'remote-tab', worktreeId: REMOTE_WORKTREE })]
      }
    }
    const applyPull = (): void => {
      const state = store.getState()
      const merged = mergeDirectSshRemoteWorkspaceSession(
        buildWorkspaceSessionPayload(state),
        hostStillListing,
        new Set([REMOTE_WORKTREE]),
        state.tabsByWorktree,
        new Set(),
        undefined,
        state.closedTerminalTabTombstonesByTabId
      )
      const replaceWorkspaceKeys = [REMOTE_WORKTREE]
      store.getState().hydrateWorkspaceSession(merged, { replaceWorkspaceKeys })
      store.getState().hydrateTabsSession(merged, { replaceWorkspaceKeys })
    }

    store.getState().closeTab('remote-tab')
    applyPull()
    // A second pull: once re-added, a live local tab would override its record for good.
    applyPull()

    expect(store.getState().tabsByWorktree[REMOTE_WORKTREE]?.map((tab) => tab.id) ?? []).toEqual([])
  })
})
