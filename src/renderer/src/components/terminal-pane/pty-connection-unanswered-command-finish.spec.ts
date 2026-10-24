import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionUnansweredCommandFinishTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('command-finished cleanup when the shell check cannot answer', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    async function connectUnansweredRow() {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const { createCommandFinishedStatusStore } =
        await import('./command-finished-status-store-test-fixture')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
      const data: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'ssh:conn@@pty-claude-exit'
      const tabId = 'tab-ssh-claude-exit'
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          data.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const exited = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing connection fixtures supply the pane, manager and deps consumed by the installer.
      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connection deps fixture supplies every dependency consumed by the installer.
        createDeps({
          tabId,
          isVisibleRef: { current: false },
          onAgentExitedRef: { current: exited }
        }) as never
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      const store = createCommandFinishedStatusStore()
      store.acceptClaudeStatus(paneKey, 'done')
      store
        .getState()
        .registerAgentLaunchConfig(
          paneKey,
          { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
          { agentType: 'claude' }
        )
      const sync = (): void => {
        mockStoreState.agentStatusByPaneKey = store.getState().agentStatusByPaneKey
        mockStoreState.agentLaunchConfigByPaneKey = store.getState().agentLaunchConfigByPaneKey
      }
      sync()
      const off = store.subscribe(sync)
      mockStoreState.dropAgentStatus.mockImplementation(store.dropAgentStatus)
      const finish = async () => {
        data.current?.('\x1b]133;D;0\x07')
        await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
        await flushAsyncTicks()
      }
      return { paneKey, ptyId, store, data, finish, off, exited }
    }

    it.each([false, true, 'rejected'] as const)(
      'settles a real nonretained row only when unavailable presence is %s, without shell or death',
      async (verifiable) => {
        const p = await connectUnansweredRow()
        const presence = vi.fn(() =>
          verifiable === 'rejected'
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(verifiable)
        )
        Object.assign(window.api.agentStatus, { hasVerifiableAgentProcess: presence })
        try {
          await p.finish()
          expect(presence).toHaveBeenCalledWith(p.paneKey)
          expect(p.store.getStatus(p.paneKey) !== undefined).toBe(verifiable === true)
          expect(p.store.getState().agentLaunchConfigByPaneKey[p.paneKey] !== undefined).toBe(
            verifiable === true
          )
          expect(mockStoreState.paneForegroundAgentByPaneKey[p.paneKey]).toBeUndefined()
          expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
          expect(p.exited).not.toHaveBeenCalled()
        } finally {
          p.off()
        }
      }
    )

    it('rejects a presence answer superseded by C, a newer owner or recovery, then accepts a later current D', async () => {
      const p = await connectUnansweredRow()
      const presence = vi.fn<() => Promise<boolean>>()
      Object.assign(window.api.agentStatus, { hasVerifiableAgentProcess: presence })
      const deferred = createDeferred<boolean>()
      presence.mockReturnValue(deferred.promise)
      try {
        await p.finish()
        p.data.current?.('\x1b]133;C\x07')
        deferred.resolve(false)
        await flushAsyncTicks()
        expect(p.store.getStatus(p.paneKey)).toBeDefined()
        const newer = createDeferred<boolean>()
        presence.mockReturnValue(newer.promise)
        await p.finish()
        p.store
          .getState()
          .setAgentStatus(p.paneKey, { agentType: 'codex', state: 'working', prompt: 'new owner' })
        newer.resolve(false)
        await flushAsyncTicks()
        expect(p.store.getStatus(p.paneKey)?.agentType).toBe('codex')
        const recovery = createDeferred<boolean>()
        presence.mockReturnValue(recovery.promise)
        await p.finish()
        mockStoreState.suppressedPtyExitIds[p.ptyId] = true
        recovery.resolve(false)
        await flushAsyncTicks()
        expect(p.store.getStatus(p.paneKey)?.agentType).toBe('codex')
        delete mockStoreState.suppressedPtyExitIds[p.ptyId]
        presence.mockRejectedValue(new Error('presence unavailable'))
        await p.finish()
        expect(p.store.getStatus(p.paneKey)).toBeUndefined()
        expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
        expect(p.exited).not.toHaveBeenCalled()
        expect(mockStoreState.paneForegroundAgentByPaneKey[p.paneKey]?.shellForeground).not.toBe(
          true
        )
      } finally {
        p.off()
      }
    })
  })
}
