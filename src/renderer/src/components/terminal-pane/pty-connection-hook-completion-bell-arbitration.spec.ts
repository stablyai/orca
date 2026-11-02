import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
} from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

    it('leaves SSH IPC OSC 9999 status ownership in the main runtime', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-ssh')
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
    })

    it('lets delayed hook completion notifications win over concurrent terminal bells', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-hook')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['tab-pty'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'tab-pty' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-hook')
      transportFactoryQueue.push(transport)
      enableActiveRuntimeEnvironment()
      mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

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

    it('forwards raw onData after a bell as a query reply', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!bellHandler || !onDataHandler) {
        throw new Error('expected bell and onData handlers to be registered')
      }

      bellHandler()
      ;(onDataHandler as (data: string) => void)('a')

      expect(deps.markTerminalBell).toHaveBeenCalledWith({
        worktreeId: 'wt-1',

        tabId: 'tab-1',

        paneKey: makePaneKey('tab-1', LEAF_1)
      })
      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
    })

    // Why: on a stale-codex pane (pending account-switch restart), production blocks sendInput.
    it('blocks onData on a stale codex pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-codex-stale')
      transportFactoryQueue.push(transport)
      // isCodexPaneStale reads codexRestartNoticeByPtyId; seed a restart notice to trigger the stale branch.
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-codex-stale']
        },
        codexRestartNoticeByPtyId: {
          'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
        }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      ;(onDataHandler as (data: string) => void)('a')

      // Stale-codex input is also blocked from reaching the transport.
      expect(transport.sendInput).not.toHaveBeenCalled()
    })
  })
}
