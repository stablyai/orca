import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, renderHeadlessBuffer } from './pty-connection-test-async'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
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
  toast: { info: toastInfo }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

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

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

const HOST_COLS = 143
const HOST_ROWS = 12
const PANE_COLS = 120
const PANE_ROWS = 40

// A serialized TUI frame the way @xterm/addon-serialize emits one: newline-fed
// rows plus a trailing absolute CUP. Both are grid-relative.
const HOST_FRAME = `\x1b[?1049h\x1b[2J\x1b[H${Array.from(
  { length: HOST_ROWS },
  (_unused, index) => `host row ${index + 1}`
).join('\r\n')}\x1b[${HOST_ROWS};3H`

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

async function connectRemotePane(): Promise<{
  operations: { kind: 'resize' | 'write'; value: string }[]
  pane: ReturnType<typeof createPane>
  transport: MockTransport
  replay: (data: string, meta?: Record<string, unknown>) => void
  dispose: () => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, 'env-1')
  const transport = createMockTransport('remote:env-1@@terminal-1')
  const captured: { current: ConnectCallbacks['onReplayData'] | null } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
    captured.current = callbacks.onReplayData ?? null
    return { id: 'remote:env-1@@terminal-1', replay: '' }
  })
  transportFactoryQueue.push(transport)

  const pane = createPane(1)
  pane.terminal.cols = PANE_COLS
  pane.terminal.rows = PANE_ROWS
  const operations: { kind: 'resize' | 'write'; value: string }[] = []
  pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
    operations.push({ kind: 'write', value: data })
    callback?.()
  })
  pane.terminal.resize = vi.fn((cols: number, rows: number) => {
    operations.push({ kind: 'resize', value: `${cols}x${rows}` })
    pane.terminal.cols = cols
    pane.terminal.rows = rows
  })
  pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: PANE_COLS, rows: PANE_ROWS }))
  pane.fitAddon.fit = vi.fn(() => {
    pane.terminal.resize(PANE_COLS, PANE_ROWS)
  })

  const manager = createManager(1)
  const disposable = connectPanePty(pane as never, manager as never, createDeps() as never)
  await flushAsyncTicks(6)
  transport.resize.mockClear()

  return {
    operations,
    pane,
    transport,
    replay: (data, meta) => captured.current?.(data, meta as never),
    dispose: () => disposable.dispose()
  }
}

describe('pushed remote snapshot replay grid', () => {
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

  it('replays at the host grid and then pushes the pane grid back to the PTY', async () => {
    const session = await connectRemotePane()

    session.replay(HOST_FRAME, { snapshotCols: HOST_COLS, snapshotRows: HOST_ROWS })
    await flushAsyncTicks(20)

    const frameWriteIndex = session.operations.findIndex(
      (operation) => operation.kind === 'write' && operation.value === HOST_FRAME
    )
    const sourceResizeIndex = session.operations.findIndex(
      (operation) => operation.kind === 'resize' && operation.value === `${HOST_COLS}x${HOST_ROWS}`
    )
    expect(sourceResizeIndex).toBeGreaterThanOrEqual(0)
    expect(frameWriteIndex).toBeGreaterThan(sourceResizeIndex)
    // Why the PTY push matters: the pane must not be left driving the host at
    // the replay geometry once the destination fit has run.
    expect(session.transport.resize).toHaveBeenCalledWith(PANE_COLS, PANE_ROWS)
    expect(session.transport.resize).not.toHaveBeenCalledWith(HOST_COLS, HOST_ROWS)
    session.dispose()
  })

  it('keeps the pane grid when the host published no snapshot dimensions', async () => {
    const session = await connectRemotePane()

    session.replay(HOST_FRAME)
    await flushAsyncTicks(20)

    expect(session.pane.terminal.resize).not.toHaveBeenCalledWith(HOST_COLS, HOST_ROWS)
    session.dispose()
  })

  it('only reproduces the host frame when it is parsed at the host grid', async () => {
    const atHostGrid = await renderHeadlessBuffer([HOST_FRAME], HOST_COLS, HOST_ROWS)
    const atPaneGrid = await renderHeadlessBuffer([HOST_FRAME], PANE_COLS, HOST_ROWS - 4)

    // Why this is the user-visible failure: the alternate screen has no
    // scrollback, so rows scrolled off by a shorter grid are gone for good and
    // an idle TUI never repaints them.
    expect(atHostGrid.filter((line) => line.startsWith('host row'))).toHaveLength(HOST_ROWS)
    expect(atPaneGrid.filter((line) => line.startsWith('host row')).length).toBeLessThan(HOST_ROWS)
    expect(atPaneGrid).not.toContain('host row 1')
  })
})
