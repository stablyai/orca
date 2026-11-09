import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../test-fixtures/pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import type * as UseNotificationDispatchModule from '../../notifications/use-notification-dispatch'
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
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionTaskCompleteDispatchTests(): void {
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

    it('does not dispatch generic spinner completions when process inspection finds no agent', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-shell')
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const api = (
        globalThis as unknown as {
          window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
        }
      ).window.api
      api.pty.getForegroundProcess.mockResolvedValue('zsh')
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks2))
      )

      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!titleHandler) {
        throw new Error('Expected onTitleChange to be registered')
      }

      titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
      titleHandler('experimental-agent-observability', 'experimental-agent-observability')
      await flushAsyncTicks()

      vi.advanceTimersByTime(16_000)

      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    })

    it('queues the idle cursor reset behind hidden agent output', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks8))
      )
      await flushAsyncTicks(6)
      vi.useFakeTimers()

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!capturedDataCallback.current || !idleHandler) {
        throw new Error('Expected PTY data and idle handlers to be registered')
      }

      capturedDataCallback.current('\x1b[6 q')
      idleHandler('* Codex done')

      expect(pane.terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      expect(pane.terminal.write).toHaveBeenCalledWith(`\x1b[6 q${RESET_TERMINAL_CURSOR_STYLE}`)
    })

    it('does not use stale agent status from an earlier turn in task-complete notifications', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { useNotificationDispatch } = await vi.importActual<
        typeof UseNotificationDispatchModule
      >('../../notifications/use-notification-dispatch')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const dispatchNotification = useNotificationDispatch('wt-1')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'Previous task that must not leak',
        updatedAt: Date.now() - 15_000,
        stateStartedAt: Date.now() - 20_000,
        agentType: 'codex',
        paneKey,
        terminalTitle: '* Codex done',
        stateHistory: [],
        lastAssistantMessage: 'Old response'
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ dispatchNotification })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks11))
      )

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!idleHandler) {
        throw new Error('Expected onAgentBecameIdle to be registered')
      }

      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      await flushAsyncTicks()

      const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as Record<string, unknown> | undefined
      if (!dispatchArgs) {
        throw new Error('Expected notification dispatch')
      }
      expect(dispatchArgs).toMatchObject({
        source: 'agent-task-complete',
        worktreeId: 'wt-1',
        terminalTitle: '* Codex done'
      })
      expect('agentPrompt' in dispatchArgs).toBe(false)
      expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
      expect('agentType' in dispatchArgs).toBe(false)
    })
  })
}
