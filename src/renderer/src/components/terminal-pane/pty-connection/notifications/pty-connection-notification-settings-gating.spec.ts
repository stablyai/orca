import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../test-fixtures/pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
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
  loadFreshTerminalModules,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionNotificationSettingsGatingTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function notifyStoreSubscribers(): void {
    for (const listener of storeSubscribers.slice()) {
      listener(mockStoreState)
    }
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
      // Each test binds the once-per-load settings subscription to its own store.
      await loadFreshTerminalModules()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('lets concurrent agent-complete notifications win over terminal bell notifications', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { useNotificationDispatch } = await vi.importActual<
        typeof UseNotificationDispatchModule
      >('../../notifications/use-notification-dispatch')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const dispatchNotification = useNotificationDispatch('wt-1')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey = mockStoreState.agentStatusByPaneKey.replace([
        [
          paneKey,
          {
            state: 'done',
            prompt: 'Fix notification payloads',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            agentType: 'codex',
            paneKey,
            terminalTitle: '* Codex done',
            stateHistory: [],
            lastAssistantMessage: 'Implemented the formatter.'
          }
        ]
      ])

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ dispatchNotification })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!bellHandler || !idleHandler) {
        throw new Error('Expected bell and idle handlers to be registered')
      }

      bellHandler()
      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      await flushAsyncTicks()

      expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
      expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: '* Codex done',
          agentType: 'codex',
          agentLastAssistantMessage: 'Implemented the formatter.'
        })
      )
    })

    it('keeps an in-flight generic completion when desktop completion banners are enabled', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-codex')
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          enabled: true,
          agentTaskComplete: false,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: null
        }
      }
      const inspection = createDeferred<string | null>()
      const api = (
        globalThis as unknown as {
          window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
        }
      ).window.api
      api.pty.getForegroundProcess.mockReturnValue(inspection.promise)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
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
      expect(window.api.pty.inspectProcess).toHaveBeenCalledWith('pty-codex')
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: true
        }
      }
      notifyStoreSubscribers()
      inspection.resolve('codex')
      await flushAsyncTicks()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(deps.dispatchNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: 'experimental-agent-observability',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(1)
    })

    it('restores a suppressed terminal bell when disabling pending agent completion', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-codex')
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: null
        }
      }
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
      )

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!bellHandler || !idleHandler) {
        throw new Error('Expected bell and idle handlers to be registered')
      }

      bellHandler()
      idleHandler('* Codex done')
      vi.advanceTimersByTime(250)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )

      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: false
        }
      }
      notifyStoreSubscribers()
      vi.advanceTimersByTime(250)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
    })
  })
}
