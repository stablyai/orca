import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
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

  it('resets renderer cursor style when an agent becomes idle', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

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

    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('resets stale keyboard state when a native Windows agent becomes idle', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
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

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps SSH agent idle reset cursor-only on Windows clients', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      mockStoreState = {
        ...mockStoreState,
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
      } as StoreState
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

      expect(pane.terminal.write).toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
    } finally {
      restoreUserAgent()
    }
  })

  it.each([
    {
      name: 'WSL',
      configure: (): void => {
        mockStoreState.tabsByWorktree = {
          'wt-1': [{ id: 'tab-1', ptyId: null, shellOverride: 'wsl.exe' }]
        }
      }
    },
    {
      name: 'remote runtime',
      configure: (): void => {
        mockStoreState.repos = [
          {
            id: 'repo1',
            connectionId: null,
            displayName: 'orca',
            executionHostId: 'runtime:owner-runtime'
          }
        ]
      }
    }
  ])(
    'keeps $name focus reports and idle reset remote-safe on Windows clients',
    async ({ configure }) => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        configure()
        const pane = createPane(1)
        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

        const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
          | ((title: string) => void)
          | undefined
        if (!idleHandler) {
          throw new Error('Expected onAgentBecameIdle to be registered')
        }
        idleHandler('* Codex done')

        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
        transport.sendInput.mockClear()
        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      } finally {
        restoreUserAgent()
      }
    }
  )

  it('resets stale keyboard state when native Windows hook status reaches done', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()
      expect(pane.terminal.write).not.toHaveBeenCalled()

      const doneStatus = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
      notifyStoreSubscribers()

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('resets stale keyboard state when a batched done→working→done burst lands as one publication', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const firstDoneAt = Date.now()
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'first turn',
        updatedAt: firstDoneAt,
        stateStartedAt: firstDoneAt,
        agentType: 'codex',
        paneKey,
        stateHistory: [{ state: 'working', prompt: 'first turn', startedAt: firstDoneAt - 5_000 }]
      }
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // The burst's intermediate `working` never publishes, so the entry stays `done` end-to-end;
      // only the stateHistory row proves a second turn ran and re-armed the kitty protocol.
      const secondDoneAt = firstDoneAt + 10_000
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'second turn',
        updatedAt: secondDoneAt,
        stateStartedAt: secondDoneAt,
        agentType: 'codex',
        paneKey,
        stateHistory: [
          { state: 'working', prompt: 'first turn', startedAt: firstDoneAt - 5_000 },
          { state: 'done', prompt: 'first turn', startedAt: firstDoneAt },
          { state: 'working', prompt: 'second turn', startedAt: secondDoneAt - 2_000 }
        ]
      }
      notifyStoreSubscribers()

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('resets stale keyboard state when a batched burst ends on working after a completed turn', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const startedAt = Date.now()
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'ship it',
        updatedAt: startedAt,
        stateStartedAt: startedAt,
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      notifyStoreSubscribers()
      expect(pane.terminal.write).not.toHaveBeenCalled()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'follow-up',
        updatedAt: startedAt + 8_000,
        stateStartedAt: startedAt + 8_000,
        agentType: 'codex',
        paneKey,
        stateHistory: [
          { state: 'working', prompt: 'ship it', startedAt },
          { state: 'done', prompt: 'ship it', startedAt: startedAt + 4_000 }
        ]
      }
      notifyStoreSubscribers()

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps native Windows same-turn done repaints from re-resetting keyboard state', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const doneAt = Date.now()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: doneAt,
        stateStartedAt: doneAt,
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()
      const writesAfterDone = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.length

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: doneAt + 1_000,
        stateStartedAt: doneAt,
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()

      expect((pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        writesAfterDone
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('drops native Windows Codex focus reports while a history resume is idle', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({
          startup: {
            command: "codex 'resume' 'codex-session-1'",
            launchAgent: 'codex',
            telemetry: {
              agent_kind: 'codex',
              launch_source: 'sidebar',
              request_kind: 'resume'
            }
          }
        }) as never
      )

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeUndefined()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).not.toHaveBeenCalled()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'continue the resumed session',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()

      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
    } finally {
      restoreUserAgent()
    }
  })

  it.each([
    {
      name: 'Claude history resume',
      launchAgent: 'claude',
      agentKind: 'claude',
      requestKind: 'resume'
    },
    {
      name: 'fresh Codex launch',
      launchAgent: 'codex',
      agentKind: 'codex',
      requestKind: 'new'
    }
  ])(
    'keeps focus reports enabled for a native Windows $name',
    async ({ launchAgent, agentKind, requestKind }) => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const pane = createPane(1)
        pane.terminal.modes.sendFocusMode = true

        connectPanePty(
          pane as never,
          createManager(1) as never,
          createDeps({
            startup: {
              command: `${launchAgent} session-command`,
              launchAgent,
              telemetry: {
                agent_kind: agentKind,
                launch_source: 'sidebar',
                request_kind: requestKind
              }
            }
          }) as never
        )

        transport.sendInput.mockClear()
        sendTerminalInputThroughPane(pane, '\x1b[O')
        sendTerminalInputThroughPane(pane, '\x1b[I')

        expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O')
        expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I')
      } finally {
        restoreUserAgent()
      }
    }
  )

  it('drops only focus reports while native Windows Codex is done and resumes them when working', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true
      const doneStatus = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
      notifyStoreSubscribers()
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      idleHandler?.('* Codex done')
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).not.toHaveBeenCalled()

      sendTerminalInputThroughPane(pane, '\x7f')
      sendTerminalInputThroughPane(pane, 'x')
      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x7f')
      expect(transport.sendInput).toHaveBeenNthCalledWith(2, 'x')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        ...doneStatus,
        state: 'working'
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        ...doneStatus,
        state: 'waiting'
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[O')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O')
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps focus reports enabled for native Windows Cursor completion', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'cursor',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')

      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O')
      expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)
    } finally {
      restoreUserAgent()
    }
  })

  it('unsubscribes the native Windows done reset watcher on pane dispose', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      const binding = connectPanePty(pane as never, manager as never, deps as never)
      binding.dispose()
      pane.terminal.write.mockClear()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()

      expect(pane.terminal.write).not.toHaveBeenCalled()
    } finally {
      restoreUserAgent()
    }
  })
})
