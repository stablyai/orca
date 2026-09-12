import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createKeyboardEventTarget, keyEvent } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
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

  it('infers interrupts only from the focused terminal key target', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop this task',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const unrelatedTarget = createKeyboardEventTarget()
    ;(
      globalThis.window as unknown as { addEventListener?: ReturnType<typeof vi.fn> }
    ).addEventListener = vi.fn()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    unrelatedTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    vi.advanceTimersByTime(500)
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(globalThis.window.addEventListener).not.toHaveBeenCalled()

    terminalTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop this task',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('clears stale working pane title after inferred interrupt applies', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { resolveWorktreeStatus } = await import('@/lib/worktree-status')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop visible spinner',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
    expect(
      resolveWorktreeStatus({
        tabs: [{ id: 'tab-1', title: 'Codex working' }],
        browserTabs: [],
        ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
        runtimePaneTitlesByTabId: mockStoreState.runtimePaneTitlesByTabId,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: true,
        hasRetainedDone: false
      })
    ).toBe('done')
  })

  it('clears unchanged title-only working indicators after acknowledged interrupt input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
  })

  it('does not clear title-only working indicators when interrupt writes are unacknowledged', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.updateTabTitle).not.toHaveBeenCalled()
  })

  it('infers exact Ctrl+C terminal input when keydown capture misses the press', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop from real terminal byte',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop from real terminal byte',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('marks bracketed paste as stale after acknowledged Ctrl+C input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { pasteTerminalText } = await import('./terminal-bracketed-paste')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.modes.bracketedPasteMode = true
    const observedIgnoreValues: (boolean | undefined)[] = []
    pane.terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(pane.terminal.options.ignoreBracketedPasteMode)
    })
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    pasteTerminalText(pane.terminal as never, 'a69ce28e1d092e0c8825cd1a109ac36409962bc1')

    expect(observedIgnoreValues).toEqual([true])
    expect(pane.terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('infers captured Ctrl+C even when xterm emits an enhanced keyboard sequence', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop enhanced keyboard input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x1b[99;5u')
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop enhanced keyboard input',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('infers interrupt for an explicit working status even if the title is already non-agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop after process exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Terminal 1'
      }
    }
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop after process exit',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps inferred interrupted status after the pane settles on a non-agent title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop and leave shell',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'stop and leave shell',
        interrupted: true,
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        paneKey,
        terminalTitle: 'Terminal 1'
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('does not infer exact interrupt input when the transport cannot acknowledge writes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'ssh style write',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes agent status and pane title on PTY exit after inferred interrupt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop then exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    if (!onPtyExit) {
      throw new Error('expected onPtyExit callback to be registered')
    }

    onPtyExit('tab-pty')

    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'tab-pty')
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, null)
    expect(mockStoreState.removeAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('ignores repeated and modified terminal interrupt keydowns', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'keep running',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    for (const event of [
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: true
      },
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        repeat: false
      },
      {
        key: 'c',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        repeat: false
      }
    ]) {
      terminalTarget.dispatch(event as KeyboardEvent)
    }
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer Ctrl+C when terminal selection turns the chord into copy', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'copy selection',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown; hasSelection: ReturnType<typeof vi.fn> }).element =
      terminalTarget.target
    ;(pane.terminal as { hasSelection: ReturnType<typeof vi.fn> }).hasSelection.mockReturnValue(
      true
    )

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes the terminal key listener on dispose before a remount adds another', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const firstTransport = createMockTransport()
    const secondTransport = createMockTransport()
    transportFactoryQueue.push(firstTransport, secondTransport)
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    const firstConnection = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps() as never
    )
    expect(terminalTarget.handlers.size).toBe(1)

    firstConnection.dispose()
    expect(terminalTarget.handlers.size).toBe(0)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    expect(terminalTarget.handlers.size).toBe(1)
    expect(
      terminalTarget.target.addEventListener.mock.calls.filter(([type]) => type === 'keydown')
    ).toHaveLength(2)
    expect(
      terminalTarget.target.removeEventListener.mock.calls.filter(([type]) => type === 'keydown')
    ).toHaveLength(1)
  })
})
