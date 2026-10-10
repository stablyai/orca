import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  TEST_REPO,
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '../slices/store-test-helpers'
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

{
  const mockApi = createStoreCascadesMockApi()
  const mockWindow = globalThis.window
  const closeTerminalSurface = vi.fn()
  Object.assign(mockApi, { session: { closeTerminalSurface } })

  const SSH_WORKTREE = 'remote-repo::/srv/app'
  const SSH_PTY = 'ssh:target@@pty2:1:1'

  function storeWithSshTab(): ReturnType<typeof createTestStore> {
    const store = createTestStore()
    seedStore(store, {
      repos: [{ ...TEST_REPO, id: 'remote-repo', path: '/srv/app', connectionId: 'ssh-1' }],
      worktreesByRepo: {
        'remote-repo': [makeWorktree({ id: SSH_WORKTREE, repoId: 'remote-repo', path: '/srv/app' })]
      },
      tabsByWorktree: {
        [SSH_WORKTREE]: [makeTab({ id: 'ssh-tab', worktreeId: SSH_WORKTREE, ptyId: SSH_PTY })]
      },
      ptyIdsByTabId: { 'ssh-tab': [SSH_PTY] }
    })
    return store
  }

  describe('closeTab close intent', () => {
    beforeEach(() => {
      globalThis.window = mockWindow
    })

    beforeEach(() => {
      vi.clearAllMocks()
      closeTerminalSurface.mockResolvedValue(undefined)
      mockApi.worktrees.updateMeta.mockResolvedValue({})
    })

    it('commits the close in main even when the SSH shutdown throws', async () => {
      mockApi.pty.kill.mockRejectedValue(new Error('relay shutdown failed'))
      const store = storeWithSshTab()

      store.getState().closeTab('ssh-tab')
      await Promise.resolve()

      expect(mockApi.pty.kill).toHaveBeenCalledWith(SSH_PTY)
      expect(closeTerminalSurface).toHaveBeenCalledWith({
        worktreeId: SSH_WORKTREE,
        target: { kind: 'tab', tabId: 'ssh-tab' },
        reason: 'user'
      })
    })

    it('removes the tab and kills it without waiting for main to write the close', async () => {
      closeTerminalSurface.mockReturnValue(new Promise<void>(() => {}))
      const store = storeWithSshTab()

      store.getState().closeTab('ssh-tab')

      expect(closeTerminalSurface).toHaveBeenCalledTimes(1)
      expect(store.getState().tabsByWorktree[SSH_WORKTREE]).toEqual([])
      await Promise.resolve()
      expect(mockApi.pty.kill).toHaveBeenCalledWith(SSH_PTY)
    })

    it.each([['user'], ['cleanup']] as const)('sends the intent for a %s close', (reason) => {
      storeWithSshTab().getState().closeTab('ssh-tab', { reason })

      expect(closeTerminalSurface).toHaveBeenCalledTimes(1)
    })

    // Why: exits still retire through main's own exit handling until main decides exits itself.
    it('sends nothing for a pty-exit close', () => {
      storeWithSshTab().getState().closeTab('ssh-tab', { reason: 'pty-exit' })

      expect(closeTerminalSurface).not.toHaveBeenCalled()
    })

    it('sends nothing when a paired host owns the close', () => {
      storeWithSshTab().getState().closeTab('ssh-tab', { remoteCloseOwnedByHost: true })

      expect(closeTerminalSurface).not.toHaveBeenCalled()
    })
  })
}

{
  const mockApi = createStoreCascadesMockApi()
  const mockWindow = globalThis.window

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
      globalThis.window = mockWindow
    })

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
}

{
  const mockApi = createStoreCascadesMockApi()
  const mockWindow = globalThis.window

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
      globalThis.window = mockWindow
    })

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

      expect(store.getState().tabsByWorktree[REMOTE_WORKTREE]?.map((tab) => tab.id) ?? []).toEqual(
        []
      )
    })
  })
}
