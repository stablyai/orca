import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

    it('lets concurrent agent-complete notifications win over terminal bell notifications', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { useNotificationDispatch } = await vi.importActual<
        typeof UseNotificationDispatchModule
      >('./use-notification-dispatch')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const dispatchNotification = useNotificationDispatch('wt-1')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
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

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ dispatchNotification })

      connectPanePty(pane as never, manager as never, deps as never)

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

    it('does not suppress terminal bell notifications when agent-complete notifications are disabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
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
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent-task-complete'
        })
      )
    })

    it('raises terminal attention for agent completion when OS completion notifications are disabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-codex')
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        experimentalTerminalAttention: true,
        notifications: {
          enabled: true,
          agentTaskComplete: false,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: null
        }
      }
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!idleHandler) {
        throw new Error('Expected idle handler to be registered')
      }

      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
    })

    it('shares one raw store subscriber for agent-complete notification settings across panes', async () => {
      const { connectPanePty } = await import('./pty-connection')
      transportFactoryQueue.push(createMockTransport('pty-1'), createMockTransport('pty-2'))

      vi.useFakeTimers()
      const firstBinding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps() as never
      )
      const secondBinding = connectPanePty(
        createPane(2) as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks()

      expect(storeSubscribers).toHaveLength(1)

      firstBinding.dispose()
      expect(storeSubscribers).toHaveLength(1)
      secondBinding.dispose()
      expect(storeSubscribers).toHaveLength(0)
    })

    it('offers generic title completions while desktop completion banners are disabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const api = (
        globalThis as unknown as {
          window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
        }
      ).window.api
      api.pty.getForegroundProcess.mockResolvedValue('codex')
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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

    it('keeps an in-flight generic completion when desktop completion banners are enabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)

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

    it('keeps raw title completion continuity across desktop banner changes', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)

      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!titleHandler) {
        throw new Error('Expected onTitleChange to be registered')
      }

      titleHandler('Claude working', 'Claude working')
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: false
        }
      }
      notifyStoreSubscribers()
      titleHandler('Claude done', 'Claude done')
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: true
        }
      }
      notifyStoreSubscribers()
      titleHandler('Claude done', 'Claude done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(deps.dispatchNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: 'Claude done',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(1)
    })

    it('keeps a scheduled agent completion across desktop banner changes', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!idleHandler) {
        throw new Error('Expected onAgentBecameIdle to be registered')
      }

      idleHandler('* Codex done')
      vi.advanceTimersByTime(500)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: false
        }
      }
      notifyStoreSubscribers()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: true
        }
      }
      notifyStoreSubscribers()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 500 - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(deps.dispatchNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: '* Codex done',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(1)
    })

    it('restores a suppressed terminal bell when disabling pending agent completion', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)

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

    it('delivers completion after working and desktop banner changes', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)

      const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
        | (() => void)
        | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!workingHandler || !idleHandler) {
        throw new Error('Expected working and idle handlers to be registered')
      }

      workingHandler()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: false
        }
      }
      notifyStoreSubscribers()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: true
        }
      }
      notifyStoreSubscribers()
      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(deps.dispatchNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: '* Codex done',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(1)
    })

    it('delivers completion after working starts with desktop banners disabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
        | (() => void)
        | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!workingHandler || !idleHandler) {
        throw new Error('Expected working and idle handlers to be registered')
      }

      workingHandler()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        notifications: {
          ...mockStoreState.settings.notifications,
          agentTaskComplete: true
        }
      }
      notifyStoreSubscribers()
      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(deps.dispatchNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: '* Codex done',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledTimes(1)
    })
  })
}
