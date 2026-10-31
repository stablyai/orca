import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import type * as IpcPtyTransportModule from './pty-transport'
import { expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  sendTerminalInputThroughPane,
  temporarilySetNavigatorUserAgent
} from './pty-connection-test-dom'
import { LEAF_1, createPane, createManager } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { PaneConnectionDeps } from './pty-connection-test-deps'
import { foregroundSemantics } from './pty-connection-test-store-fixtures'

export function registerPtyConnectionForegroundHostRoutingTests(context: {
  getState: () => StoreState
  createDeps: (overrides?: Record<string, unknown>) => PaneConnectionDeps
  useIpcTransport: (factory: typeof IpcPtyTransportModule.createIpcPtyTransport) => void
  advanceVisibleForegroundRead: () => Promise<void>
  foregroundReadCallsFor: (ptyId: string) => unknown[][]
}): void {
  it('keeps admitted local foreground ownership across workspace selection, detach and exact end', async () => {
    const mockStoreState = context.getState()
    vi.useFakeTimers()
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      context.useIpcTransport(
        (await vi.importActual<typeof IpcPtyTransportModule>('./pty-transport'))
          .createIpcPtyTransport
      )
      const { connectPanePty } = await import('./pty-connection')
      const residents = await import('./terminal-side-effect-facts-handler')
      const { reattachPtyDispatcherPushListeners } = await import('./pty-dispatcher')
      reattachPtyDispatcherPushListeners()
      const { resolveTerminalPaneOwnerContext } = await import('./terminal-pane-owner-context')
      const ptyId = 'pty-tab-local-host-proof'
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const local = { id: 'wt-1', repoId: 'repo1', path: 'C:\\repo', hostId: 'local' }
      mockStoreState.tabsByWorktree['wt-1'] = [{ id: 'tab-1', ptyId: null }]
      mockStoreState.ptyIdsByTabId['tab-1'] = []
      mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}
      mockStoreState.unifiedTabsByWorktree['wt-1'] = [
        {
          id: 'unified-local',
          contentType: 'terminal',
          entityId: 'tab-1',
          executionHostId: 'local',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
      mockStoreState.repos = [
        { id: 'repo1', connectionId: null, executionHostId: 'local' },
        { id: 'repo1', connectionId: null, executionHostId: 'runtime:other' }
      ]
      mockStoreState.worktreesByRepo = { repo1: [local, { ...local, hostId: 'runtime:other' }] }
      Object.assign(mockStoreState, {
        activeWorkspaceExecutionHostId: 'runtime:other',
        getKnownWorktreeById: (id: string, host: string) =>
          mockStoreState.worktreesByRepo.repo1.find((row) => row.id === id && row.hostId === host)
      })
      expect(
        // SAFETY: this fixture supplies the host-qualified catalog, tab and lookup read by this resolver.
        resolveTerminalPaneOwnerContext(mockStoreState as never, 'wt-1', 'tab-1', null)
      ).toMatchObject({ executionHostId: 'local', connectionId: null, unresolved: false })
      const spawn = createDeferred<{ id: string; incarnationId: string }>()
      Object.assign(window.api.pty, {
        spawn: vi.fn(() => spawn.promise),
        resize: vi.fn(),
        claimViewport: vi.fn()
      })
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
      const read = createDeferred<string | null>()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(read.promise)
      const deps = context.createDeps({ cwd: local.path })
      const pane = createPane(1)
      const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(40)
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
      expect(window.api.pty.spawn).toHaveBeenCalledOnce()
      expect(residents.getTerminalSemanticResident(ptyId)).toBeUndefined()
      expect(window.api.pty.getForegroundProcess).not.toHaveBeenCalled()
      expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalled()
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalled()

      spawn.resolve({ id: ptyId, incarnationId: 'local-1' })
      await flushAsyncTicks(40)
      const resident = residents.getTerminalSemanticResident(ptyId)
      expect(resident?.identity).toMatchObject({
        executionHost: 'local',
        incarnationId: 'local-1'
      })
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, ptyId)
      binding.sampleForegroundAgentOnFocus()
      await context.advanceVisibleForegroundRead()
      expect(context.foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
      expect(
        foregroundSemantics(mockStoreState.paneForegroundAgentByPaneKey[paneKey])
      ).toMatchObject({ agent: 'droid', agentEvidence: 'process-read' })
      sendTerminalInputThroughPane(pane, 'droid\r')
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledExactlyOnceWith(ptyId)
      Object.assign(mockStoreState, { activeWorkspaceExecutionHostId: 'local' })
      binding.dispose()
      expect(residents.getTerminalSemanticResident(ptyId)).toBe(resident)
      expect(resident?.isLive).toBe(true)
      Object.assign(mockStoreState, { activeWorkspaceExecutionHostId: 'runtime:other' })
      read.resolve('droid')
      await flushAsyncTicks(40)
      expect(
        foregroundSemantics(mockStoreState.paneForegroundAgentByPaneKey[paneKey])
      ).toMatchObject({ agent: 'droid', agentEvidence: 'process-read', routingTrusted: true })

      const pending = createDeferred<string | null>()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(pending.promise)
      const onData = vi.mocked(window.api.pty.onData).mock.calls[0]?.[0]
      if (!onData) {
        throw new Error('Missing real physical-source data callback')
      }
      onData({ id: ptyId, data: '\x1b]133;C\x07' })
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledTimes(2)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenLastCalledWith(ptyId)
      residents.retireTerminalSemanticResident(ptyId, 'local-1')
      expect(resident?.isLive).toBe(false)
      expect(residents.getTerminalSemanticResident(ptyId)).toBeUndefined()
      Object.assign(window.api.pty, {
        spawn: vi.fn().mockResolvedValue({ id: ptyId, incarnationId: 'local-2', isReattach: true })
      })
      const successorBinding = connectPanePty(
        ...mockPanePtyArgs(createPane(1), createManager(1), deps)
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(40)
      const successor = residents.getTerminalSemanticResident(ptyId)
      expect(successor).toBeDefined()
      expect(successor).not.toBe(resident)
      expect(successor?.identity.incarnationId).toBe('local-2')
      const writes = mockStoreState.setPaneForegroundAgent.mock.calls.length
      const entry = mockStoreState.paneForegroundAgentByPaneKey[paneKey]
      pending.resolve('zsh')
      await flushAsyncTicks(40)
      expect(successor?.isLive).toBe(true)
      expect(residents.getTerminalSemanticResident(ptyId)).toBe(successor)
      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledTimes(writes)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toBe(entry)
      successorBinding.dispose()
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps a positively admitted no-view SSH source on host inspection', async () => {
    const mockStoreState = context.getState()
    vi.useFakeTimers()
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const handler = await import('./terminal-side-effect-facts-handler')
      const { reattachPtyDispatcherPushListeners } = await import('./pty-dispatcher')
      reattachPtyDispatcherPushListeners()
      const ptyId = 'ssh:host-proof@@remote-process'
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.tabsByWorktree['wt-1'][0].ptyId = ptyId
      mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = { [LEAF_1]: ptyId }
      const present = createDeferred<boolean>()
      vi.mocked(window.api.pty.hasPty).mockReturnValue(present.promise)
      vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
        foregroundProcess: 'codex',
        hasChildProcesses: true,
        foregroundProcessEvidence: {
          verdict: 'live',
          processName: 'codex',
          ptyId: 'remote-process',
          ptyIncarnationId: 'ssh-1',
          authorityGeneration: 'host-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          fence: {
            platform: 'posix',
            shellPid: 100,
            shellStartTime: '1000',
            tty: '/dev/pts/3',
            foregroundPgid: 200
          }
        }
      })
      handler.followLocalTerminalSemanticSource({
        ptyId,
        incarnationId: 'ssh-1',
        byteSource: true,
        binding: { paneKey, tabId: 'tab-1', worktreeId: 'wt-1', cwd: '/remote/repo' }
      })
      expect(window.api.pty.hasPty).toHaveBeenCalledExactlyOnceWith(ptyId)
      expect(handler.getTerminalSemanticResident(ptyId)).toBeUndefined()
      expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
      present.resolve(true)
      await flushAsyncTicks(40)
      expect(handler.getTerminalSemanticResident(ptyId)?.identity).toMatchObject({
        executionHost: 'ssh:host-proof',
        incarnationId: 'ssh-1'
      })
      const onData = vi.mocked(window.api.pty.onData).mock.calls[0]?.[0]
      if (!onData) {
        throw new Error('Missing admitted SSH source callback')
      }
      onData({ id: ptyId, data: '\x1b]133;C\x07' })
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.inspectProcess).toHaveBeenCalledExactlyOnceWith(ptyId, {
        expectedIncarnationId: 'ssh-1'
      })
      expect(window.api.pty.getForegroundProcess).not.toHaveBeenCalled()
      expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalled()
      expect(
        foregroundSemantics(mockStoreState.paneForegroundAgentByPaneKey[paneKey])
      ).toMatchObject({ agent: 'codex', agentEvidence: 'process-read', shellForeground: false })
    } finally {
      restoreUserAgent()
    }
  })
}
