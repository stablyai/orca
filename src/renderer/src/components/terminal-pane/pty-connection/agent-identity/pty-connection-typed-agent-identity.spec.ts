import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
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

export function registerPtyConnectionTypedAgentIdentityTests(): void {
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

    it('keeps GPU enabled when a pane-scoped OMP owner emits a Gemini-looking title', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'omp',
            state: 'working',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-omp-gemini-cwd')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // Pane-scoped owner evidence outranks the raw title, so the fallback cannot fire.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, true)
      expect(manager.setPaneGpuRendering).not.toHaveBeenCalledWith(1, false)
    })

    it('does not let one split pane title change another pane GPU state', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const pane1 = createPane(1)
      const pane2 = createPane(2)
      const transport1 = createMockTransport('pty-split-1')
      const transport2 = createMockTransport('pty-split-2')
      transportFactoryQueue.push(transport1, transport2)
      const manager = createManager(2, 1)

      connectPanePty(
        pane1 as never,
        manager as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks4)
      )
      connectPanePty(
        pane2 as never,
        manager as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks4)
      )
      await flushAsyncTicks()
      const onTitleChange1 = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange1) {
        throw new Error('missing title callback for split pane 1')
      }
      onTitleChange1('✦ Gemini CLI', '✦ Gemini CLI')

      const gpuCalls = manager.setPaneGpuRendering.mock.calls as [number, boolean][]
      expect(gpuCalls.some(([paneId]) => paneId === 1)).toBe(true)
      expect(gpuCalls.every(([paneId]) => paneId !== 2)).toBe(true)
    })

    it('does not infer shell ownership from prompts typed in a title-only Pi session', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Pi ready' } }
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-pi-title-only')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks12)
      )
      sendTerminalInputThroughPane(pane, 'omp\r')
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      if (!onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(transport.sendInput).toHaveBeenCalledWith('omp\r', 'query-reply')
      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'pi',
        terminalTitle: 'Pi ready'
      })
    })

    it('lets a new typed omp command override a stale retained done status', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const now = Date.now()
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: '',
        agentType: 'pi',
        paneKey,
        terminalTitle: 'Pi ready',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-stale-done')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks13)
      )
      sendTerminalInputThroughPane(pane, 'omp\r')
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      if (!onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'omp'
      })
    })

    it('skips manual agent inference for large paste chunks', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks16 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-large-paste')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks16)
      )
      sendTerminalInputThroughPane(pane, `${' '.repeat(4097)}omp\r`)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      if (!onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'pi'
      })
    })

    it('resumes manual agent inference when large paste input is cancelled', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks17 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-cancelled-large-paste')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks17)
      )
      sendTerminalInputThroughPane(pane, 'x'.repeat(4097))
      sendTerminalInputThroughPane(pane, '\x03')
      sendTerminalInputThroughPane(pane, 'omp\r')
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      if (!onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'omp'
      })
    })

    it('preserves typed shell ownership through same-chunk command-finished side effects', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks18 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const transport = createMockTransport('remote:env-1@@pty-command-finished')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks?.onData ?? null
          return 'remote:env-1@@pty-command-finished'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks18)
      )
      sendTerminalInputThroughPane(pane, 'omp\r')
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      const dataCallback = dataCallbackRef.current
      if (!dataCallback || !onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      dataCallback('\x1b]133;D;0\x07')
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'omp'
      })
    })
  })
}
