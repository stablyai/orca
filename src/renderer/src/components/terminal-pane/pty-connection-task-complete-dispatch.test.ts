import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { YOLO_TUI_AGENT_ARGS } from '../../../../shared/tui-agent-permissions'
import { flushAsyncTicks } from './pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
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
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
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
  scheduleTerminalWebglAtlasRecovery
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

function notifyStoreSubscribers(): void {
  for (const listener of storeSubscribers.slice()) {
    listener(mockStoreState)
  }
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

  it('dispatches agent-task-complete for generic Codex spinner titles after process identity is confirmed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
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

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: 'experimental-agent-observability',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
    expect(window.api.pty.inspectProcess).toHaveBeenCalledWith('pty-codex')
  })

  it('does not dispatch generic spinner completions when process inspection finds no agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
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

    vi.advanceTimersByTime(16_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('dispatches agent-task-complete from recognized hook completion events', async () => {
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
          state: 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('suppresses PTY-owned Codex auto-approved permission statuses before status or notification work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
        agentEnv: {}
      }
    }

    const launchConfig = {
      agentCommand: 'codex',
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      agentEnv: {}
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig,
        launchToken: 'launch-yolo',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'waiting'
          prompt: string
          agentType: 'codex'
          toolName: string
          toolInput: string
        }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'waiting',
      prompt: 'auto-approved permission',
      agentType: 'codex',
      toolName: 'exec_command',
      toolInput: 'git status'
    })

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
  })

  it('suppresses synthetic Codex auto-approved permission titles before title work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
        agentEnv: {}
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
          agentEnv: {}
        },
        launchToken: 'launch-yolo',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }
    mockStoreState.getAgentLaunchConfigForStatusMetadata.mockClear()

    titleHandler('Codex - action required', 'Codex - action required')

    expect(mockStoreState.getAgentLaunchConfigForStatusMetadata).toHaveBeenCalledTimes(1)
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.updateTabTitle).not.toHaveBeenCalled()
    expect(manager.setPaneGpuRendering).not.toHaveBeenCalled()
  })

  it('does not resolve launch config for ordinary title changes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)

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
    mockStoreState.getAgentLaunchConfigForStatusMetadata.mockClear()

    for (let index = 0; index < 100; index += 1) {
      titleHandler(`build output ${index}`, `build output ${index}`)
    }

    expect(mockStoreState.getAgentLaunchConfigForStatusMetadata).not.toHaveBeenCalled()
  })

  it('preserves synthetic Codex manual permission titles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: '',
        agentEnv: {}
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: {}
        },
        launchToken: 'launch-manual',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Codex - action required', 'Codex - action required')

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Codex - action required')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Codex - action required')
  })

  it('normalizes Pi-compatible remote titles to authoritative OMP launch identity', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-omp')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
    }
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: '\u280b Pi' } }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }
    titleHandler('\u280b Pi', '\u280b Pi')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '\u280b OMP')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '\u280b OMP')
    titleHandler('π: tmp', 'π: tmp')
    expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
    expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'OMP ready')

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'working'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'fix the remote title',
      agentType: 'pi'
    })

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'fix the remote title',
        agentType: 'omp',
        observation: expect.objectContaining({ origin: 'osc', kind: 'snapshot' })
      },
      '\u280b OMP',
      undefined,
      { connectionId: null }
    )

    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
    }
    statusHandler({
      state: 'working',
      prompt: 'keep the remote title',
      agentType: 'pi'
    })

    expect(mockStoreState.setAgentStatus).toHaveBeenLastCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'keep the remote title',
        agentType: 'omp',
        observation: expect.objectContaining({ origin: 'osc', kind: 'snapshot' })
      },
      '\u280b OMP',
      undefined,
      { connectionId: null }
    )
  })

  it('keeps GPU rendering enabled for OMP titles whose cwd is Gemini', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-omp-gemini-cwd')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    manager.setPaneGpuRendering.mockClear()

    titleHandler('\u280b Pi', '\u280b π: gemini')

    expect(manager.setPaneGpuRendering).toHaveBeenCalledTimes(1)
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, true)
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '\u280b OMP')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '\u280b OMP')
  })

  it('leaves local IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-local')
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('queues the idle cursor reset behind hidden agent output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
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

  it('waits briefly for delayed agent status before dispatching task-complete', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use delayed hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Delayed status arrived.'
    }

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use delayed hook status in notification',
        agentLastAssistantMessage: 'Delayed status arrived.'
      })
    )
  })

  it('waits past the grace delay when the assistant message arrives shortly after it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use the late hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Late status arrived.'
    }
    notifyStoreSubscribers()
    await flushAsyncTicks()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 350)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use the late hook status in notification',
        agentLastAssistantMessage: 'Late status arrived.'
      })
    )
  })

  it('does not use stale agent status from an earlier turn in task-complete notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
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

    connectPanePty(pane as never, manager as never, deps as never)

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

  it('does not attach agent fields to terminal-bell notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Should not leak into BEL',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    vi.useFakeTimers()
    bellHandler()
    vi.advanceTimersByTime(250)

    const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown> | undefined
    if (!dispatchArgs) {
      throw new Error('Expected notification dispatch')
    }
    expect(dispatchArgs.source).toBe('terminal-bell')
    expect('agentType' in dispatchArgs).toBe(false)
    expect('agentState' in dispatchArgs).toBe(false)
    expect('agentPrompt' in dispatchArgs).toBe(false)
    expect('agentToolName' in dispatchArgs).toBe(false)
    expect('agentToolInput' in dispatchArgs).toBe(false)
    expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
    expect('agentInterrupted' in dispatchArgs).toBe(false)
  })

  // Why: agent-row removal belongs to process/PTY lifecycle, not title reversion, so interrupts can't disappear the activity row.
  it('clears the cache timer without removing agent status when the title tracker sees exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const agentExitedHandler = createdTransportOptions[0]?.onAgentExited as (() => void) | undefined
    if (!agentExitedHandler) {
      throw new Error('Expected onAgentExited to be registered')
    }

    agentExitedHandler()

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1), null)
    expect(deps.onAgentExitedRef.current).toHaveBeenCalledWith(LEAF_1)
    expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
  })
})
