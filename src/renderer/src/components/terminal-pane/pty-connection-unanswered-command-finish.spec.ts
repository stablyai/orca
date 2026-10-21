import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
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

    it.each([
      ['clears', 'a row without a process identity', false],
      ['keeps', 'a row whose agent process the host can check', true]
    ])(
      '%s %s when an SSH pane finishes and the shell check cannot answer',
      async (_verb, _label, verifiable) => {
        vi.useFakeTimers()
        const { connectPanePty } = await import('./pty-connection')
        vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
        const hasVerifiableAgentProcess = vi.fn(async () => verifiable)
        Object.assign(window.api.agentStatus, { hasVerifiableAgentProcess })
        const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
        const ptyId = 'ssh:conn@@pty-codex-exit'
        const tabId = 'tab-ssh-codex-exit'
        const paneKey = makePaneKey(tabId, LEAF_1)
        const transport = createMockTransport(ptyId)
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            dataCallbackRef.current = callbacks.onData ?? null
            return { id: ptyId }
          }
        )
        transportFactoryQueue.push(transport)
        mockStoreState = {
          ...mockStoreState,
          agentStatusByPaneKey: {
            [paneKey]: {
              paneKey,
              state: 'done',
              prompt: 'remote task',
              updatedAt: 1_000,
              stateStartedAt: 900,
              agentType: 'codex',
              terminalTitle: 'Codex',
              stateHistory: []
            }
          }
        }

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          createDeps({ tabId, isVisibleRef: { current: false } }) as never
        )
        await vi.advanceTimersByTimeAsync(20)
        await flushAsyncTicks()
        mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
          launchConfig: { agentArgs: '', agentEnv: {} },
          identity: { agentType: 'codex' }
        }

        dataCallbackRef.current?.('\x1b]133;D;0\x07')
        await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
        await flushAsyncTicks()

        expect(hasVerifiableAgentProcess).toHaveBeenCalledWith(paneKey)
        if (verifiable) {
          expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
        } else {
          expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
        }
      }
    )
  })
}
