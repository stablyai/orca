import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
} from '../test-fixtures/pty-connection-test-constants'
import {
  LEAF_1,
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

export function registerPtyConnectionHookCompletionBellArbitrationTests(): void {
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
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('lets delayed hook completion notifications win over concurrent terminal bells', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-hook')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
      )

      const statusHandler = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: {
            state: 'working' | 'done'
            prompt: string
            agentType: 'codex'
            lastAssistantMessage?: string
          }) => void)
        | undefined
      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!statusHandler || !bellHandler) {
        throw new Error('Expected hook status and bell handlers to be registered')
      }

      statusHandler({
        state: 'working',
        prompt: 'finish the implementation',
        agentType: 'codex'
      })
      statusHandler({
        state: 'done',
        prompt: 'finish the implementation',
        agentType: 'codex',
        lastAssistantMessage: 'Done.'
      })
      bellHandler()

      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )

      vi.advanceTimersByTime(
        AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS
      )
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: 'codex',
          paneKey: makePaneKey('tab-1', LEAF_1),
          agentStatusSnapshot: expect.objectContaining({
            state: 'done',
            prompt: 'finish the implementation',
            agentType: 'codex',
            lastAssistantMessage: 'Done.'
          })
        })
      )
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
    })

    it('restores a suppressed terminal bell when a delayed hook completion resumes work', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['tab-pty'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'tab-pty' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )

      const statusHandler = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: {
            state: 'working' | 'done'
            prompt: string
            agentType: 'codex'
            lastAssistantMessage?: string
          }) => void)
        | undefined
      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!statusHandler || !bellHandler) {
        throw new Error('Expected hook status and bell handlers to be registered')
      }

      statusHandler({
        state: 'working',
        prompt: 'finish the implementation',
        agentType: 'codex'
      })
      statusHandler({
        state: 'done',
        prompt: 'finish the implementation',
        agentType: 'codex',
        lastAssistantMessage: 'Done.'
      })
      bellHandler()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )

      statusHandler({
        state: 'working',
        prompt: 'finish the implementation',
        agentType: 'codex'
      })
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    })

    it('restores a suppressed terminal bell when a delayed hook completion resumes via title tracking', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-hook')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
      )

      const statusHandler = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: {
            state: 'working' | 'done'
            prompt: string
            agentType: 'codex'
            lastAssistantMessage?: string
          }) => void)
        | undefined
      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
        | (() => void)
        | undefined
      if (!statusHandler || !bellHandler || !workingHandler) {
        throw new Error('Expected hook status, bell, and working handlers to be registered')
      }

      statusHandler({
        state: 'working',
        prompt: 'finish the implementation',
        agentType: 'codex'
      })
      statusHandler({
        state: 'done',
        prompt: 'finish the implementation',
        agentType: 'codex',
        lastAssistantMessage: 'Milestone complete.'
      })
      bellHandler()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )

      workingHandler()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    })

    it('restores a suppressed terminal bell when the pending agent completion is canceled', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
        | (() => void)
        | undefined
      if (!bellHandler || !idleHandler || !workingHandler) {
        throw new Error('Expected bell, idle, and working handlers to be registered')
      }

      bellHandler()
      idleHandler('* Codex done')
      workingHandler()
      vi.advanceTimersByTime(250)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell' })
      )
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    })

    it('cancels a title task-complete notification when the agent resumes before quiet', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
        | (() => void)
        | undefined
      if (!idleHandler || !workingHandler) {
        throw new Error('Expected idle and working handlers to be registered')
      }

      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )

      workingHandler()
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )

      idleHandler('* Codex done')
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      expect(deps.dispatchNotification).toHaveBeenCalledWith({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        paneKey: makePaneKey('tab-1', LEAF_1),
        ptyId: 'tab-pty'
      })
    })
  })
}
