import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { TEST_REPO } from '../../repos/repo.test-fixture'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../testing/app-store-cascade-api.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => ({
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

    it('removes the tab without waiting for main to write the close', async () => {
      closeTerminalSurface.mockReturnValue(new Promise<void>(() => {}))
      layoutApplyTestTransport.answerWith('pending')
      const store = storeWithSshTab()

      store.getState().closeTab('ssh-tab')

      expect(store.getState().tabsByWorktree[SSH_WORKTREE]).toEqual([])
      await Promise.resolve()
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

      store.getState().closeTab('tab-a')

      const after = store.getState()

      expect(after.expandedPaneByTabId).toEqual({ 'tab-b': false })
      expect(after.pendingStartupByTabId).toEqual({})
      expect(after.cacheTimerByKey).toEqual({ 'tab-b:leaf': 2 })
      expect(after.unreadTerminalPanes).toEqual({})
    })
  })
}
