import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, expect, it, vi } from 'vitest'
import type { createTestStore as createStoreFixture } from '@/store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

afterEach(async () => {
  await restoreTerminalTestGlobals()
  vi.restoreAllMocks()
})

it('keeps an acknowledged interrupt clear when the delayed tracker reports an owner', async () => {
  vi.resetModules()
  vi.clearAllMocks()
  const transportFactoryQueue: MockTransport[] = []
  const createdTransportOptions: Record<string, unknown>[] = []
  let productionStore: ReturnType<typeof createStoreFixture> | undefined
  const mockStoreState: StoreState = createInitialStoreState(() => mockStoreState)
  bindPtyConnectionTestMocks({
    getState: () => mockStoreState,
    getProductionStore: () => productionStore,
    getTransportQueue: () => transportFactoryQueue,
    getTransportOptions: () => createdTransportOptions,
    getStoreSubscribers: () => [],
    setStoreSubscribers: () => {}
  })
  await installTerminalTestGlobals()
  const createDeps = (overrides: Record<string, unknown>) =>
    buildPaneConnectionDeps(() => mockStoreState, overrides)
  vi.useFakeTimers()
  const { createTestStore, makeTab, makeWorktree, TEST_REPO } =
    await import('@/store/slices/store-test-helpers')
  Object.assign(window.api, {
    settings: { getSync: () => ({ terminalMainSideEffectAuthority: false }) }
  })
  productionStore = createTestStore()
  const store = productionStore
  const { createGlobalSettingsFixture } =
    await import('../../../../shared/global-settings-test-fixture')
  store.setState({
    settings: createGlobalSettingsFixture({ terminalMainSideEffectAuthority: false }),
    repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
    },
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-late-interrupt' })]
    }
  })
  const statusWrites = vi.spyOn(store.getState(), 'setAgentStatus')
  const completionModule = await import('./agent-completion-coordinator')
  const completionFactory = vi.spyOn(completionModule, 'createAgentCompletionCoordinator')
  const { connectPanePty } = await import('./pty-connection')
  const paneKey = makePaneKey('tab-1', LEAF_1)
  const pane = createPane(1)
  const transport = createMockTransport('pty-late-interrupt')
  transportFactoryQueue.push(transport)
  const deps = createDeps({
    isVisibleRef: { current: false },
    setRuntimePaneTitle: vi.fn((tab: string, paneId: number, title: string) =>
      store.getState().setRuntimePaneTitle(tab, paneId, title)
    ),
    clearRuntimePaneTitle: vi.fn((tab: string, paneId: number) =>
      store.getState().clearRuntimePaneTitle(tab, paneId)
    )
  })
  const manager = createManager(1, 1)
  const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
  await vi.advanceTimersByTimeAsync(20)
  const coordinator = completionFactory.mock.results.find((result) => result.type === 'return')
  if (!coordinator || coordinator.type !== 'return') {
    throw new Error('missing live completion coordinator')
  }
  const titleObservations = vi.spyOn(coordinator.value, 'observeTitle')
  let finishRead: ((value: string) => void) | undefined
  vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finishRead = resolve
      })
  )
  const { onTitleChange } = createdTransportOptions[0]
  if (typeof onTitleChange !== 'function') {
    throw new Error('missing live title consumer')
  }
  onTitleChange('⠋ Pi', '⠋ Pi')
  expect(titleObservations).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(350)
  sendTerminalInputThroughPane(pane, '\x03')
  await flushAsyncTicks()
  await vi.advanceTimersByTimeAsync(500)
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  const effects = {
    title: titleObservations.mock.calls.length,
    cache: deps.setCacheTimerStartedAt.mock.calls.length,
    status: statusWrites.mock.calls.length,
    mode: pane.terminal.write.mock.calls.length
  }
  if (!finishRead) {
    throw new Error('missing production tracker read')
  }
  finishRead('omp')
  await flushAsyncTicks()
  expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.agent).toBe('omp')
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'Terminal')
  expect(titleObservations).toHaveBeenCalledTimes(effects.title)
  expect(deps.setCacheTimerStartedAt).toHaveBeenCalledTimes(effects.cache)
  expect(statusWrites).toHaveBeenCalledTimes(effects.status)
  expect(pane.terminal.write).toHaveBeenCalledTimes(effects.mode)
  onTitleChange('Pi ready', 'Pi ready')
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('OMP ready')
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'droid',
    agentEvidence: 'process-read',
    routingTrusted: true,
    shellForeground: false
  })
  vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('cmd.exe')
  binding.requestWindowsShiftEnterReconfirmation()
  await vi.advanceTimersByTimeAsync(350 + 350 + 1200 + 6000)
  expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.shellForeground).toBe(true)
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'omp',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  onTitleChange('Pi ready', 'Pi ready')
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('OMP ready')
  const { onPtyExit } = createdTransportOptions[0]
  if (typeof onPtyExit !== 'function') {
    throw new Error('missing real exit consumer')
  }
  onPtyExit('pty-late-interrupt', 0)
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'pi',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBeUndefined()
  binding.dispose()
})
