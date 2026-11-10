import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionRemoteRuntimeAttachTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
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

    it('reports remote renderer readiness only after delayed restore output is parsed', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      let remoteCallbacks: ConnectCallbacks | undefined
      transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue('remote:env-1@@terminal-delayed')
        remoteCallbacks = callbacks
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-delayed' }]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      } as StoreState
      const pane = createPane(2)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        pane as never,
        createManager(2) as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks4)
      )
      await flushAsyncTicks()
      expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

      remoteCallbacks?.onReplayData?.('delayed restored prompt $ ')
      remoteCallbacks?.onConnect?.()
      await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
      expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

      for (let step = 0; step < 10; step += 1) {
        await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
        parseCallbacks.shift()?.()
        await flushAsyncTicks()
        if (vi.mocked(window.api.pty.reportRendererSerializerReady!).mock.calls.length > 0) {
          break
        }
      }
      expect(writes.join('')).toContain('delayed restored prompt $ ')
      await vi.waitFor(() =>
        expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(
          'remote:env-1@@terminal-delayed'
        )
      )
    })
  })
}
