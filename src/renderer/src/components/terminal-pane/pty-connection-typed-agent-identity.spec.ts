import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport,
  type ConnectCallbacks
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { createTestStore } from '@/store/slices/store-test-helpers'
import type { IpcPtyTransportOptions } from './pty-transport-types'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

function checkedTitleCallback(
  options: Record<string, unknown>
): NonNullable<IpcPtyTransportOptions['onTitleChange']> {
  const { onTitleChange } = options
  if (typeof onTitleChange !== 'function') {
    throw new Error('missing live title callback')
  }
  return (title, rawTitle) => onTitleChange(title, rawTitle)
}

function checkedTitleCallbacks(options: Record<string, unknown>): {
  onTitleChange: NonNullable<IpcPtyTransportOptions['onTitleChange']>
  onAgentStatus: NonNullable<IpcPtyTransportOptions['onAgentStatus']>
} {
  const { onAgentStatus } = options
  if (typeof onAgentStatus !== 'function') {
    throw new Error('missing live status callback')
  }
  return {
    onTitleChange: checkedTitleCallback(options),
    onAgentStatus: (payload) => onAgentStatus(payload)
  }
}

export function registerPtyConnectionTypedAgentIdentityTests(): void {
  let mockStoreState: StoreState
  let productionStore: ReturnType<typeof createTestStore> | undefined
  let notifications = 0
  let selections = 0
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, {
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId[tabId] = {
          ...mockStoreState.runtimePaneTitlesByTabId[tabId],
          [paneId]: title
        }
      }),
      ...overrides
    })
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
      productionStore = undefined
      notifications = 0
      selections = 0
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getProductionStore: () => productionStore,
        onStoreNotification: () => {
          notifications += 1
        },
        onStoreSelection: () => {
          selections += 1
        },
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

    it.each([false, true])(
      'keeps observed Pi identity without real OMP evidence (reattach=%s)',
      async (partialReattach) => {
        vi.useFakeTimers()
        const { connectPanePty } = await import('./pty-connection')
        enableActiveRuntimeEnvironment()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        const transport = createMockTransport(null)
        const callbacksRef: { current?: ConnectCallbacks } = {}
        const connect = transport.connect.getMockImplementation()
        transport.connect.mockImplementation(async (options) => {
          callbacksRef.current = options.callbacks
          return connect?.(options)
        })
        transportFactoryQueue.push(transport)
        const manager = createManager(1, 1)
        const deps = createDeps({
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
        })

        const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
        await vi.advanceTimersByTimeAsync(20)
        await flushAsyncTicks(20)
        if (partialReattach) {
          sendTerminalInputThroughPane(pane, 'om')
          if (!callbacksRef.current?.onReattachDetermined) {
            throw new Error('missing reattach callback')
          }
          callbacksRef.current.onReattachDetermined()
        }
        sendTerminalInputThroughPane(pane, partialReattach ? 'p\r' : 'omp\r')
        await vi.advanceTimersByTimeAsync(20)
        await flushAsyncTicks(20)
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

        expect(transport.sendInput).toHaveBeenCalledWith(
          partialReattach ? 'p\r' : 'omp\r',
          'query-reply'
        )
        expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
        expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Pi ready')
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          state: 'done',
          agentType: 'pi'
        })
        binding.dispose()
      }
    )

    it('drives runtime title, tab title, and renderer policy from one title decision', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-gemini')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // Display/runtime/tab title and the GPU gate all come from the same decision.
      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '✦ Gemini CLI')
      expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '✦ Gemini CLI')
      // Genuine Gemini under the default `auto` setting takes the DOM fallback.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('keeps GPU enabled when a pane-scoped OMP owner emits a Gemini-looking title', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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
      const { connectPanePty } = await import('./pty-connection')
      const pane1 = createPane(1)
      const pane2 = createPane(2)
      const transport1 = createMockTransport('pty-split-1')
      const transport2 = createMockTransport('pty-split-2')
      transportFactoryQueue.push(transport1, transport2)
      const manager = createManager(2, 1)

      connectPanePty(pane1 as never, manager as never, createDeps() as never)
      connectPanePty(pane2 as never, manager as never, createDeps() as never)
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

    it('DOM-gates a genuine Gemini split pane even when the tab launched a non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      // The shared tab.launchAgent must not veto the renderer for a sibling pane.
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
        }
      } as StoreState
      const pane1 = createPane(1)
      const pane2 = createPane(2)
      const transport1 = createMockTransport('pty-split-owner-1')
      const transport2 = createMockTransport('pty-split-owner-2')
      transportFactoryQueue.push(transport1, transport2)
      const manager = createManager(2, 2)

      connectPanePty(pane1 as never, manager as never, createDeps() as never)
      connectPanePty(pane2 as never, manager as never, createDeps() as never)
      await flushAsyncTicks()
      const onTitleChange2 = createdTransportOptions[1]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange2) {
        throw new Error('missing title callback for split pane 2')
      }
      onTitleChange2('✦ Gemini CLI', '✦ Gemini CLI')

      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(2, false)
    })

    it('DOM-gates a genuine Gemini title in a pane whose launch agent was non-Gemini', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-gemini')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      // Stale, never-cleared launch identity must not veto the renderer.
      const deps = createDeps({ startup: { command: 'claude', launchAgent: 'claude' } })

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('DOM-gates a genuine Gemini title when the only pane row is a done non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'claude',
            state: 'done',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-done-row')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // A `done` row is a leftover from a prior agent, so it must not veto.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('DOM-gates a genuine Gemini title when the only pane row is a stale non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const staleAt = Date.now() - 60 * 60 * 1000
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'claude',
            state: 'working',
            prompt: '',
            updatedAt: staleAt,
            stateStartedAt: staleAt,
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-stale-row')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // A stale working row (older than AGENT_STATUS_STALE_AFTER_MS) must not veto.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it.each([false, true])(
      'uses process-read OMP with title first=%s without inventing status',
      async (titleFirst) => {
        const { connectPanePty } = await import('./pty-connection')
        enableActiveRuntimeEnvironment()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        transportFactoryQueue.push(createMockTransport('remote:web-env-1@@observed-omp'))
        const manager = createManager(1, 1)
        const deps = createDeps()
        connectPanePty(...mockPanePtyArgs(pane, manager, deps))
        await flushAsyncTicks()
        const callbacks = checkedTitleCallbacks(createdTransportOptions[0])
        const title = () => callbacks.onTitleChange('Pi ready', 'Pi ready')
        const status = () =>
          callbacks.onAgentStatus({ state: 'working', prompt: 'task', agentType: 'pi' })
        if (titleFirst) {
          title()
          status()
        }
        const prior = mockStoreState.agentStatusByPaneKey[paneKey]
        const writes = mockStoreState.setAgentStatus.mock.calls.length
        mockStoreState.setPaneForegroundAgent(paneKey, {
          agent: 'omp',
          agentEvidence: 'process-read',
          shellForeground: false
        })
        for (const subscriber of storeSubscribers) {
          subscriber(mockStoreState)
        }
        if (!titleFirst) {
          title()
          status()
        }
        expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
        expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'OMP ready')
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          agentType: 'omp',
          state: 'working'
        })
        if (titleFirst) {
          expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(writes)
          if (!prior || typeof prior !== 'object') {
            throw new Error('missing baseline status')
          }
          expect(mockStoreState.agentStatusByPaneKey[paneKey]).toEqual({
            ...prior,
            agentType: 'omp',
            terminalTitle: expect.stringContaining('OMP')
          })
        }
      }
    )

    it('refreshes a misleading GPU title on late process evidence without replaying completion', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      transportFactoryQueue.push(createMockTransport('pty-observed-gpu'))
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      const onTitle = checkedTitleCallback(createdTransportOptions[0])
      onTitle('✦ Gemini CLI', '✦ Gemini CLI')
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, false)
      const timerWrites = deps.setCacheTimerStartedAt.mock.calls.length
      mockStoreState.setPaneForegroundAgent(paneKey, {
        agent: 'omp',
        agentEvidence: 'process-read',
        shellForeground: false
      })
      for (const subscriber of storeSubscribers) {
        subscriber(mockStoreState)
      }
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, true)
      expect(deps.setCacheTimerStartedAt).toHaveBeenCalledTimes(timerWrites)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    })

    it('completes hidden confirmation, coalesces submits, releases unavailable reads and retries', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const paneKey = makePaneKey('tab-hidden-continuation', LEAF_1)
      transportFactoryQueue.push(createMockTransport('pty-hidden-continuation'))
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId: 'tab-hidden-continuation', isVisibleRef: { current: false } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      vi.mocked(window.api.pty.confirmForegroundProcess).mockClear()
      // Keep the independent process-exit monitor live; count the confirmation ladder alone.
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
      const reads = () =>
        vi
          .mocked(window.api.pty.confirmForegroundProcess)
          .mock.calls.filter(([id]) => id === 'pty-hidden-continuation').length
      let foreground: string | null = 'droid'
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => foreground)
      sendTerminalInputThroughPane(pane, '\r')
      await vi.advanceTimersByTimeAsync(350)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
      expect(reads()).toBe(1)
      sendTerminalInputThroughPane(pane, '\r')
      await flushAsyncTicks()
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingConfirmationPending).toBe(
        true
      )
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
      for (let index = 0; index < 10; index += 1) {
        await vi.advanceTimersByTimeAsync(20)
        sendTerminalInputThroughPane(pane, '\r')
        await flushAsyncTicks()
      }
      await vi.advanceTimersByTimeAsync(150)
      expect(reads()).toBe(2)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingTrusted).toBe(true)
      foreground = null
      sendTerminalInputThroughPane(pane, '\r')
      await flushAsyncTicks()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      expect(reads()).toBe(5)
      expect(
        mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingConfirmationPending
      ).not.toBe(true)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      foreground = 'droid'
      sendTerminalInputThroughPane(pane, '\r')
      await flushAsyncTicks()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
      await vi.advanceTimersByTimeAsync(350)
      expect(reads()).toBe(6)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingTrusted).toBe(true)
      foreground = 'cmd.exe'
      sendTerminalInputThroughPane(pane, '\x03')
      await flushAsyncTicks()
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      binding.dispose()
    })

    it('normalizes a compatible hook against only the exact pane managed OMP launch', async () => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: {},
        identity: { agentType: 'omp' }
      }
      const pane = createPane(1)
      const deps = createDeps()
      transportFactoryQueue.push(createMockTransport('remote:web-env-1@@managed-omp'))
      connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
      await flushAsyncTicks()
      const options = createdTransportOptions[0]
      if (
        typeof options.onAgentStatus !== 'function' ||
        typeof options.onTitleChange !== 'function'
      ) {
        throw new Error('missing callbacks')
      }
      options.onAgentStatus({ state: 'working', prompt: 'task', agentType: 'pi' })
      options.onTitleChange('Pi ready', 'Pi ready')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({ agentType: 'omp' })
      expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
    })

    it.each([1, 10])(
      'adds no discovery reads or identity nulls for %s known-TUI submits',
      async (count) => {
        vi.useFakeTimers()
        const { connectPanePty } = await import('./pty-connection')
        const tabId = `tab-known-tui-${count}`
        const paneKey = makePaneKey(tabId, LEAF_1)
        const pane = createPane(1)
        const ptyId = `pty-known-tui-${count}`
        transportFactoryQueue.push(createMockTransport(ptyId))
        const binding = connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            createDeps({ tabId, isVisibleRef: { current: false } })
          )
        )
        await vi.advanceTimersByTimeAsync(20)
        mockStoreState.setPaneForegroundAgent(paneKey, {
          agent: 'codex',
          agentEvidence: 'process-read',
          routingTrusted: true,
          shellForeground: false
        })
        mockStoreState.setPaneForegroundAgent.mockClear()
        vi.mocked(window.api.pty.confirmForegroundProcess).mockClear()
        for (let index = 0; index < count; index += 1) {
          sendTerminalInputThroughPane(pane, 'omp\r')
        }
        await vi.advanceTimersByTimeAsync(8_000)
        expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalledWith(ptyId)
        expect(
          mockStoreState.setPaneForegroundAgent.mock.calls.filter(([key]) => key === paneKey)
        ).toEqual([])
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
        binding.dispose()
      }
    )

    it.each([5, 50])(
      'bounds real store callbacks and isolates presentation across %s mounted connections',
      async (count) => {
        vi.useFakeTimers()
        const { createTestStore, makeTab, makeWorktree, TEST_REPO } =
          await import('@/store/slices/store-test-helpers')
        Object.assign(window.api, {
          settings: { getSync: () => ({ terminalMainSideEffectAuthority: false }) }
        })
        productionStore = createTestStore()
        const store = productionStore
        store.setState({
          repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
          worktreesByRepo: {
            [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
          },
          settings: null
        })
        const { connectPanePty } = await import('./pty-connection')
        const panes = []
        for (let index = 0; index < count; index += 1) {
          const tabId = `tab-owner-${index}`
          store.setState((state) => ({
            tabsByWorktree: {
              'wt-1': [
                ...(state.tabsByWorktree['wt-1'] ?? []),
                makeTab({ id: tabId, worktreeId: 'wt-1', ptyId: `pty-owner-${index}` })
              ]
            }
          }))
          const transport = createMockTransport(`pty-owner-${index}`)
          transport.connect.mockResolvedValue({ id: `pty-owner-${index}` })
          transportFactoryQueue.push(transport)
          const deps = createDeps({
            tabId,
            isVisibleRef: { current: false },
            setRuntimePaneTitle: vi.fn((tab: string, pane: number, title: string) =>
              store.getState().setRuntimePaneTitle(tab, pane, title)
            )
          })
          const manager = createManager(1)
          const binding = connectPanePty(...mockPanePtyArgs(createPane(1), manager, deps))
          panes.push({ binding, manager, deps, paneKey: makePaneKey(tabId, LEAF_1) })
        }
        await vi.advanceTimersByTimeAsync(20)
        for (const options of createdTransportOptions) {
          checkedTitleCallback(options)('Pi ready', 'Pi ready')
        }
        const clear = () => {
          notifications = 0
          selections = 0
          for (const pane of panes) {
            pane.deps.setRuntimePaneTitle.mockClear()
            pane.manager.setPaneGpuRendering.mockClear()
          }
        }
        clear()
        store.setState({ activeWorktreeId: 'another-host' })
        expect(notifications).toBeGreaterThanOrEqual(count)
        expect(notifications).toBeLessThanOrEqual(8 * count)
        expect(selections).toBeGreaterThan(0)
        expect(selections).toBeLessThanOrEqual(64 * count)
        for (const pane of panes) {
          expect(pane.deps.setRuntimePaneTitle).not.toHaveBeenCalled()
        }
        clear()
        store.getState().setPaneForegroundAgent('other-host:foreign', {
          agent: 'omp',
          agentEvidence: 'process-read',
          shellForeground: false
        })
        expect(notifications).toBeGreaterThanOrEqual(count)
        expect(notifications).toBeLessThanOrEqual(8 * count)
        expect(selections).toBeGreaterThan(0)
        expect(selections).toBeLessThanOrEqual(64 * count)
        for (const pane of panes) {
          expect(pane.deps.setRuntimePaneTitle).not.toHaveBeenCalled()
        }
        store
          .getState()
          .setAgentStatus(panes[0].paneKey, { state: 'working', prompt: 'task', agentType: 'pi' })
        clear()
        store.getState().setPaneForegroundAgent(panes[0].paneKey, {
          agent: 'omp',
          agentEvidence: 'process-read',
          shellForeground: false
        })
        expect(store.getState().agentStatusByPaneKey[panes[0].paneKey].agentType).toBe('omp')
        expect(panes[0].deps.setRuntimePaneTitle).toHaveBeenCalledTimes(1)
        expect(notifications).toBeLessThanOrEqual(8 * count)
        expect(selections).toBeGreaterThan(0)
        expect(selections).toBeLessThanOrEqual(64 * count)
        for (const pane of panes.slice(1)) {
          expect(pane.manager.setPaneGpuRendering).not.toHaveBeenCalled()
        }
        for (const pane of panes) {
          pane.binding.dispose()
        }
        clear()
        store.getState().setPaneForegroundAgent(panes[0].paneKey, {
          agent: 'pi',
          agentEvidence: 'process-read',
          shellForeground: false
        })
        expect(notifications).toBe(0)
        expect(selections).toBe(0)
        for (const pane of panes) {
          expect(pane.deps.setRuntimePaneTitle).not.toHaveBeenCalled()
        }
      }
    )

    it('retains OMP hook display identity through inter-turn done without GPU or routing authority', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { dispatchAgentHookTerminalLifecycle } = await import('./agent-hook-terminal-lifecycle')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      transportFactoryQueue.push(createMockTransport('pty-hook-omp'))
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      for (const state of ['working', 'done'] as const) {
        mockStoreState.setAgentStatus(paneKey, { state, prompt: 'task', agentType: 'omp' })
        dispatchAgentHookTerminalLifecycle(paneKey, { state, prompt: 'task', agentType: 'omp' })
        for (const subscriber of storeSubscribers) {
          subscriber(mockStoreState)
        }
      }
      const onTitle = checkedTitleCallback(createdTransportOptions[0])
      onTitle('Pi ready', 'Pi ready')
      expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
      onTitle('✦ Gemini CLI', '✦ Gemini CLI')
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, false)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingTrusted).not.toBe(true)
    })
  })
}
