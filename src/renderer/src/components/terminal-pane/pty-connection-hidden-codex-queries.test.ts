import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_REATTACH_RESET
} from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
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

  it('keeps hidden Codex redraw floods off the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      const hiddenCodexRedraw = `\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
      capturedDataCallback.current?.(hiddenCodexRedraw)
      vi.advanceTimersByTime(50)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenCodexRedraw)
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('keeps hidden Codex terminal query chunks on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[c')

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))

    binding.dispose()
  })

  it('keeps only coalesced hidden Codex terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const coalescedChunk = `\x1b[c\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('answers hidden OSC color queries directly inside a mixed capability-query burst', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const queryBurst = '\x1b[c\x1b]11;?\x1b\\\x1b[>q\x1b[14t\x1b[16t'
    const coalescedChunk = `${queryBurst}\x1b[?2026h${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[c\x1b[>q\x1b[14t\x1b[16t',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('answers adjacent hidden Codex OSC color queries directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const queries = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
    capturedDataCallback.current?.(`${queries}startup frame\r\n`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith(queries, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `${queries}startup frame\r\n`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps split hidden Codex terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[')
    capturedDataCallback.current?.(`c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Codex terminal queries split after ESC on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b')
    capturedDataCallback.current?.(`[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('flushes pending hidden Codex query prefixes when the pane becomes visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      isVisibleRef.current = true
      capturedDataCallback.current?.('[c')

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('keeps split hidden-to-visible Codex stateful queries behind snapshot restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-cpr\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        'snapshot-before-cpr\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('preserves live agent cursor and focus modes on hidden-to-visible snapshot restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'agent-frame\x1b[?25l',
      cols: 100,
      rows: 30,
      alternateScreen: true
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const now = Date.now()
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: '',
      agentType: 'codex',
      paneKey,
      terminalTitle: 'codex',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      // A live agent owns ?1004h (focus reporting); the plain reset's ?1004l would silence focus events until restart, since agents only enable it at startup.
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_DEAD_TUI_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('lets fresh host shell proof outrank stale live-agent metadata on reveal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'stale-agent-frame\x1b[?25l',
      cols: 100,
      rows: 30,
      alternateScreen: true,
      terminalOwner: 'shell'
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const now = Date.now()
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: '',
      agentType: 'codex',
      paneKey,
      terminalTitle: 'codex',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ isVisibleRef, startup: { command: 'codex' } }) as never
    )
    try {
      await flushAsyncTicks(6)
      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_DEAD_TUI_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('preserves current behavior when a snapshot has no host ownership proof', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'shell-frame\x1b[?25l',
      cols: 100,
      rows: 30,
      alternateScreen: false
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_DEAD_TUI_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('keeps a live alternate-screen pane interactive when a legacy snapshot omits its mode flag', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'legacy-tui-frame',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    pane.terminal.buffer.active.type = 'alternate'
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('grounds a stale alternate-screen snapshot when the host proves shell ownership', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'stale-tui-frame',
      cols: 100,
      rows: 30,
      alternateScreen: true,
      terminalOwner: 'shell'
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    pane.terminal.buffer.active.type = 'alternate'
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef, startup: { command: 'codex' } }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_DEAD_TUI_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
    } finally {
      binding.dispose()
    }
  })
})
