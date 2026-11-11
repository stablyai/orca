import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionNativeQueryReplyRoutingTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('answers cursor queries while an account notice blocks user input', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-live')
      transportFactoryQueue.push(transport)
      mockStoreState.codexRestartNoticeByPtyId = {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
      const pane = createPane(1)
      const args = mockPanePtyArgs(pane, createManager(1), createDeps())
      bindPaneAgentTitleMocks(args[2], agentTitleMocks3)

      const binding = connectPanePty(...args)
      transport.getPtyId.mockReturnValue('pty-live')
      mockStoreState.codexRestartNoticeByPtyId = {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
      sendTerminalInputThroughPane(pane, '\x1b[1;1R')
      sendTerminalInputThroughPane(pane, 'do work\r')
      expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[1;1R')
      expect(transport.sendInput).not.toHaveBeenCalledWith('do work\r', expect.anything())
      binding.dispose()
    })

    it('routes native onData query replies through sendInputImmediate, typed input through sendInput (#7329)', async () => {
      // Why this test: the mock aliases sendInputImmediate to sendInput, so other tests can't tell them apart; this pins the routing decision.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-7329')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks4))
      )
      await flushAsyncTicks()

      // xterm answers CSI 6n natively with a CPR via onData; it must take the immediate path (skips the remote 8ms debounce that corrupted it).
      sendTerminalInputThroughPane(pane, '\x1b[3;1R')
      expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[3;1R')

      // Ordinary typed input must stay on the debounced path — never immediate.
      transport.sendInputImmediate.mockClear()
      sendTerminalInputThroughPane(pane, 'yes')
      sendTerminalInputThroughPane(pane, '\x1b[A')
      expect(transport.sendInput).toHaveBeenCalledWith('yes', 'query-reply')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[A', 'query-reply')
      expect(transport.sendInputImmediate).not.toHaveBeenCalled()

      // terminal-query-reply.test proves real xterm emits this as one framed onData reply; this pins it to the immediate path.
      transport.sendInputImmediate.mockClear()
      const xtversionReply = '\x1bP>|xterm.js(6.1.0-beta.287)\x1b\\'
      sendTerminalInputThroughPane(pane, xtversionReply)
      expect(transport.sendInputImmediate).toHaveBeenCalledWith(xtversionReply)

      // Printable input is user-owned: remote cooked echo returns via PTY output, not onData, so OSC-looking text stays on normal input.
      transport.sendInput.mockClear()
      transport.sendInputImmediate.mockClear()
      const printableInputs = [']10;hello', '>|xterm.js(6.1.0-beta.287)', ']|literal-text']
      for (const data of printableInputs) {
        sendTerminalInputThroughPane(pane, data)
        expect(transport.sendInput).toHaveBeenCalledWith(data, 'query-reply')
      }
      expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    })
  })
}
