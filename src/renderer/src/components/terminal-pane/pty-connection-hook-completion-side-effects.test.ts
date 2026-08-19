import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
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

  it('preserves permission-title cursor and cache side effects through authoritative hook done', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'waiting',
      prompt: 'approve the tool call',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!idleHandler || !statusHandler) {
      throw new Error('Expected idle and hook status handlers to be registered')
    }

    idleHandler('Claude Code permission')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    statusHandler({
      state: 'done',
      prompt: 'approve the tool call',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
  })

  it('preserves a genuine hook completion after suppressing an earlier idle title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still working',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!titleHandler || !idleHandler || !statusHandler) {
      throw new Error('Expected title, idle, and hook status handlers to be registered')
    }

    titleHandler('Claude working', 'Claude working')
    titleHandler('Claude done', 'Claude done')
    idleHandler('Claude done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalled()

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    notifyStoreSubscribers()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'claude',
          lastAssistantMessage: 'Done.'
        })
      })
    )
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
    expect(storeSubscribers).toHaveLength(1)
  })

  it('applies accepted hook side effects when every completion alert consumer is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }
    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    if (!idleHandler || !statusHandler) {
      throw new Error('Expected idle and hook status handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'claude'
    })
    idleHandler('Claude done')

    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it.each([
    {
      name: 'delivers confirmed process exit despite the same stale working hook row',
      hookUpdateBeforeDispatch: 'none'
    },
    {
      name: 'delivers confirmed process exit after a same-turn working hook refresh',
      hookUpdateBeforeDispatch: 'same-turn'
    },
    {
      name: 'delivers confirmed process exit after same-turn hook identity becomes known',
      hookUpdateBeforeDispatch: 'same-turn-known-agent'
    },
    {
      name: 'cancels confirmed process exit delivery when a newer working hook row arrives',
      hookUpdateBeforeDispatch: 'new-turn'
    }
  ] as const)('$name', async ({ hookUpdateBeforeDispatch }) => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-crashed-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const crashedTurnStartedAt = Date.now()
      const initialAgentType =
        hookUpdateBeforeDispatch === 'same-turn-known-agent' ? 'unknown' : 'codex'
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'crash before done hook',
        updatedAt: crashedTurnStartedAt,
        stateStartedAt: crashedTurnStartedAt,
        agentType: initialAgentType,
        paneKey,
        stateHistory: []
      }
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!titleHandler) {
        throw new Error('Expected onTitleChange to be registered')
      }

      titleHandler('Codex working', 'Codex working')
      await vi.advanceTimersByTimeAsync(2_500)
      getForegroundProcess.mockResolvedValue(null)
      await vi.advanceTimersByTimeAsync(1_800)
      if (hookUpdateBeforeDispatch !== 'none') {
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt:
            hookUpdateBeforeDispatch === 'new-turn'
              ? 'new turn after the prior process exited'
              : 'same turn hook detail refresh',
          updatedAt: Date.now(),
          stateStartedAt:
            hookUpdateBeforeDispatch === 'new-turn' ? Date.now() : crashedTurnStartedAt,
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()
      }
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      const expectedNotification = {
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey,
        agentCompletionSource: 'process-exit'
      }
      if (hookUpdateBeforeDispatch === 'new-turn') {
        expect(deps.dispatchNotification).not.toHaveBeenCalledWith(expectedNotification)
      } else {
        expect(deps.dispatchNotification).toHaveBeenCalledWith(expectedNotification)
      }
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[I')
      sendTerminalInputThroughPane(pane, '\x7f')
      expect(transport.sendInput).toHaveBeenCalledTimes(2)
      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[I')
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x7f')
    } finally {
      restoreUserAgent()
    }
  })

  it('drops an exited agent completion when a replacement agent hook row is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
    getForegroundProcess.mockResolvedValue('codex')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Codex working', 'Codex working')
    await vi.advanceTimersByTimeAsync(2_500)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    getForegroundProcess.mockResolvedValue('claude')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    titleHandler('Claude done', 'Claude done')
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'Claude done',
        paneKey
      })
    )
  })

  it('drops confirmed idle exit when a different hook owner appears between null samples', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    // Why: pin the ±10% poll jitter to nominal so the 2nd null sample can't confirm exit before the replacement owner is set.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      // Why: one timer advance can start multiple reads; gate the 2nd+ null sample until the replacement hook owner is installed.
      let idleMode = false
      let nullSamplesStarted = 0
      let releaseConfirmingNullSample: (() => void) | undefined
      const confirmingNullSampleGate = new Promise<void>((resolve) => {
        releaseConfirmingNullSample = resolve
      })
      getForegroundProcess.mockImplementation(async () => {
        if (!idleMode) {
          return 'codex'
        }
        nullSamplesStarted += 1
        if (nullSamplesStarted >= 2) {
          await confirmingNullSampleGate
        }
        return null
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!titleHandler || !idleHandler) {
        throw new Error('Expected title and idle handlers to be registered')
      }

      titleHandler('Codex working', 'Codex working')
      await vi.advanceTimersByTimeAsync(2_500)
      idleMode = true
      for (let attempts = 0; nullSamplesStarted < 1; attempts += 1) {
        if (attempts >= 10) {
          throw new Error('Expected the first idle process inspection')
        }
        await vi.advanceTimersToNextTimerAsync()
      }
      // Why: let the first null sample apply pendingProcessExitAgent before the replacement owner is installed.
      await flushAsyncTicks()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'replacement agent turn',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'claude',
        paneKey,
        stateHistory: []
      }
      releaseConfirmingNullSample?.()
      // Ignore cursor resets from setup so this assertion only covers the replacement idle event.
      pane.terminal.write.mockClear()
      idleHandler('Claude done')
      await vi.advanceTimersByTimeAsync(800)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )
    } finally {
      // Why: an assertion failure above must not leave Math.random pinned for later tests.
      randomSpy.mockRestore()
    }
  })

  it('preserves replacement-agent title side effects through the process replacement veto', async () => {
    const { dispatchAgentHookTerminalLifecycle } = await import('./agent-hook-terminal-lifecycle')
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
    getForegroundProcess.mockResolvedValue('codex')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!titleHandler || !idleHandler) {
      throw new Error('Expected title and idle handlers to be registered')
    }

    titleHandler('Codex working', 'Codex working')
    await vi.advanceTimersByTimeAsync(2_500)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    idleHandler('Claude done')
    getForegroundProcess.mockResolvedValue('claude')
    await vi.advanceTimersByTimeAsync(1_000)

    dispatchAgentHookTerminalLifecycle(paneKey, {
      state: 'done',
      prompt: 'replacement agent turn',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })
})
