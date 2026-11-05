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
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

type CloseReason = 'user' | 'cleanup'

/** The closes main was told to record: `closeTabs` intents with the switch on, else today's call. */
function sentCloses(
  closeTerminalSurface: ReturnType<typeof vi.fn>
): { worktreeId: string; tabId: string; reason: CloseReason }[] {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    // Main hears each close once: never also through today's call.
    expect(closeTerminalSurface).not.toHaveBeenCalled()
    return layoutApplyTestTransport.sentOfType('closeTabs').map((command) => ({
      worktreeId: command.workspace,
      tabId: command.tabIds[0]!,
      reason: command.recordClose === 'cleanup' ? 'cleanup' : 'user'
    }))
  }
  return closeTerminalSurface.mock.calls.map(([args]) => ({
    worktreeId: args.worktreeId,
    tabId: args.target.tabId,
    reason: args.reason
  }))
}

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
      layoutApplyTestTransport.reset()
      closeTerminalSurface.mockResolvedValue(undefined)
      mockApi.worktrees.updateMeta.mockResolvedValue({})
    })

    it('removes the tab and kills it without waiting for main to write the close', async () => {
      closeTerminalSurface.mockReturnValue(new Promise<void>(() => {}))
      layoutApplyTestTransport.answerWith('pending')
      const store = storeWithSshTab()

      store.getState().closeTab('ssh-tab')

      expect(sentCloses(closeTerminalSurface)).toHaveLength(1)
      expect(store.getState().tabsByWorktree[SSH_WORKTREE]).toEqual([])
      await Promise.resolve()
      expect(mockApi.pty.kill).toHaveBeenCalledWith(SSH_PTY)
    })
  })
}

{
  const mockApi = createStoreCascadesMockApi()
  const mockWindow = globalThis.window

  const WORKTREE = 'repo::/tmp/app'

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
