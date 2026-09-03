import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleImagePasteWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('normalizes Pi-compatible remote runtime status to OMP after typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-omp')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
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

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'OMP ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('drives runtime title, tab title, and renderer policy from one title decision', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-gemini')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
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

    connectPanePty(pane as never, manager as never, deps as never)
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

    connectPanePty(pane as never, manager as never, deps as never)
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

    connectPanePty(pane as never, manager as never, deps as never)
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

    connectPanePty(pane as never, manager as never, deps as never)
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

  it('normalizes after shell word deletion edits a typed command to omp', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-omp-edited')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'pi \x17omp\r')
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

    expect(transport.sendInput).toHaveBeenCalledWith('pi \x17omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('keeps Pi-compatible remote runtime status as Pi after typed pi command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'pi\r')
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

    expect(transport.sendInput).toHaveBeenCalledWith('pi\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('does not infer shell ownership from prompts typed inside an existing Pi session', async () => {
    const { connectPanePty } = await import('./pty-connection')
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
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Pi ready' } }
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi-prompt')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
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

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('does not infer shell ownership from prompts typed in a title-only Pi session', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Pi ready' } }
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi-title-only')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
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

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('lets a new typed omp command override a stale retained done status', async () => {
    const { connectPanePty } = await import('./pty-connection')
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

    connectPanePty(pane as never, manager as never, deps as never)
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
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('tracks cursor edits when inferring a typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-cursor-edit')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'op\x1b[Dm\r')
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

    expect(transport.sendInput).toHaveBeenCalledWith('op\x1b[Dm\r')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('tracks delete-key cursor edits when inferring a typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-delete-edit')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'ommp\x1b[D\x1b[D\x1b[3~\r')
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
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('skips manual agent inference for large paste chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-large-paste')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, `${'x'.repeat(4097)}omp\r`)
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
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('resumes manual agent inference when large paste input is cancelled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-cancelled-large-paste')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
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
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('preserves typed shell ownership through same-chunk command-finished side effects', async () => {
    const { connectPanePty } = await import('./pty-connection')
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

    connectPanePty(pane as never, manager as never, deps as never)
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
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })
})
