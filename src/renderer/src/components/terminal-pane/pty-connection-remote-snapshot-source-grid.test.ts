import type * as React from 'react'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushAsyncTicks,
  renderHeadlessBuffer,
  writeHeadlessTerminal
} from './pty-connection-test-async'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildReattachPaneTitleState,
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
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...buildAgentStatusModuleMock(actual),
    detectAgentStatusFromTitle: actual.detectAgentStatusFromTitle
  }
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

async function connectRemotePane(
  title?: string,
  incarnationId: string | null = 'inc-old'
): Promise<{
  operations: { kind: 'resize' | 'write'; value: string }[]
  pane: ReturnType<typeof createPane>
  transport: MockTransport
  live: (data: string) => void
  rebind: (incarnationId?: string | null) => void
  replay: (data: string, meta?: Record<string, unknown>) => void
  dispose: () => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, 'env-1')
  if (title) {
    mockStoreState = buildReattachPaneTitleState(mockStoreState, title)
  }
  const transport = createMockTransport('remote:env-1@@terminal-1')
  const captured: {
    current: ConnectCallbacks['onReplayData'] | null
    live: ConnectCallbacks['onData'] | null
  } = { current: null, live: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
    captured.current = callbacks.onReplayData ?? null
    captured.live = callbacks.onData ?? null
    return { id: 'remote:env-1@@terminal-1', replay: '', incarnationId }
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
    live: (data) => captured.live?.(data),
    rebind: (nextIncarnation) => {
      const onRebind = createdTransportOptions.at(-1)?.onPtyRebind as (
        id: string,
        replacedId: string,
        incarnationId?: string | null
      ) => void
      onRebind('remote:env-1@@terminal-1', 'remote:env-1@@terminal-1', nextIncarnation)
    },
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

  it.each([
    { name: 'replacement with shell ownership', owner: 'shell' as const, expectedMouse: 'none' },
    {
      name: 'known replacement without ownership',
      owner: undefined,
      expectedMouse: 'none',
      replacement: true
    },
    { name: 'unknown legacy ownership', owner: undefined, expectedMouse: 'any' },
    {
      name: 'unknown predecessor',
      owner: undefined,
      expectedMouse: 'any',
      replacement: true,
      unknownPredecessor: true
    },
    { name: 'unknown successor', owner: undefined, expectedMouse: 'any', unknownSuccessor: true },
    {
      name: 'same-incarnation rebind',
      owner: undefined,
      expectedMouse: 'any',
      sameIncarnation: true
    },
    { name: 'surviving agent', owner: undefined, expectedMouse: 'any', liveAgent: true },
    {
      name: 'replacement agent',
      owner: undefined,
      expectedMouse: 'any',
      liveAgent: true,
      replacement: true
    }
  ])('reconciles mouse modes for a $name despite a retained Pi title', async (scenario) => {
    const session = await connectRemotePane(
      'π - remote-session',
      scenario.unknownPredecessor ? null : 'inc-old'
    )
    const terminal = new Terminal({ cols: PANE_COLS, rows: PANE_ROWS, allowProposedApi: true })
    const mouseModes = '\x1b[?1003h\x1b[?1006h'
    const snapshot = scenario.liveAgent ? `${mouseModes}LIVE_AGENT` : 'REPLACEMENT_SHELL$ '
    try {
      await writeHeadlessTerminal(terminal, `OLD_AGENT_FRAME${mouseModes}`)
      expect(terminal.modes.mouseTrackingMode).toBe('any')
      if (scenario.replacement) {
        session.rebind('inc-new')
      }
      if (scenario.sameIncarnation) {
        session.rebind('inc-old')
      }
      if (scenario.unknownSuccessor) {
        session.rebind(null)
      }
      session.replay(snapshot, {
        snapshotCols: PANE_COLS,
        snapshotRows: PANE_ROWS,
        ...(scenario.owner ? { terminalOwner: scenario.owner, alternateScreen: false } : {})
      })
      await flushAsyncTicks(20)
      const writes = session.operations.filter((operation) => operation.kind === 'write')
      expect(writes.some((operation) => operation.value.includes(snapshot))).toBe(true)
      for (const operation of writes) {
        await writeHeadlessTerminal(terminal, operation.value)
      }
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain(
        scenario.liveAgent ? 'LIVE_AGENT' : 'REPLACEMENT_SHELL$'
      )
      expect(terminal.modes.mouseTrackingMode).toBe(scenario.expectedMouse)
    } finally {
      session.dispose()
      terminal.dispose()
    }
  })

  it('grounds a retained invisible pen before painting a replacement shell snapshot', async () => {
    const session = await connectRemotePane('π - remote-session')
    const terminal = new Terminal({ cols: PANE_COLS, rows: PANE_ROWS, allowProposedApi: true })
    try {
      await writeHeadlessTerminal(terminal, 'OLD_AGENT_FRAME\x1b[8m')
      session.replay('REPLACEMENT_SHELL$ ', {
        snapshotCols: PANE_COLS,
        snapshotRows: PANE_ROWS,
        terminalOwner: 'shell',
        alternateScreen: false
      })
      await flushAsyncTicks(20)
      for (const operation of session.operations) {
        if (operation.kind === 'write') {
          await writeHeadlessTerminal(terminal, operation.value)
        }
      }
      const line = terminal.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toContain('REPLACEMENT_SHELL$')
      expect(line?.getCell(0)?.isInvisible()).toBe(0)
    } finally {
      session.dispose()
      terminal.dispose()
    }
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

  it('fits locally after source replay without claiming an unknown remote owner grid', async () => {
    const { setFitOverride, getFitOverrideForPty } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const session = await connectRemotePane()
    const id = 'remote:env-1@@terminal-1'
    setFitOverride(id, 'remote-desktop-fit', 0, 0)
    try {
      session.replay('SHELL$', { snapshotCols: 2, snapshotRows: 1 })
      await flushAsyncTicks(20)
      expect(session.pane.terminal.resize).toHaveBeenCalledWith(2, 1)
      expect(session.pane.terminal.cols).toBe(PANE_COLS)
      expect(session.pane.terminal.rows).toBe(PANE_ROWS)
      expect(session.transport.resize).not.toHaveBeenCalled()
      expect(getFitOverrideForPty(id)).toEqual({ mode: 'remote-desktop-fit', cols: 0, rows: 0 })
    } finally {
      setFitOverride(id, 'desktop-fit', 0, 0)
      session.dispose()
    }
  })

  it('retires an in-flight predecessor replay and keeps successor live output for a reused handle', async () => {
    const session = await connectRemotePane('π - remote-session')
    const write = session.pane.terminal.write.getMockImplementation()!
    let finishOldWrite: (() => void) | undefined
    session.pane.terminal.write.mockImplementation((data: string, callback?: () => void) => {
      if (data === 'STALE_FRAME') {
        write(data)
        finishOldWrite = callback
      } else {
        write(data, callback)
      }
    })
    try {
      session.replay('STALE_FRAME', {
        snapshotCols: 2,
        snapshotRows: 1,
        pendingEscapeTailAnsi: '\x1b[999;'
      })
      await flushAsyncTicks(10)
      expect(finishOldWrite).toBeTypeOf('function')
      session.live('STALE_ACK')
      session.rebind('inc-new')
      session.replay('SUCCESSOR_FRAME', { snapshotCols: 2, snapshotRows: 1 })
      session.live('LIVE_ACK')
      finishOldWrite?.()
      await flushAsyncTicks(30)
      const writes = session.operations.filter((op) => op.kind === 'write').map((op) => op.value)
      expect(writes).not.toContain('\x1b[999;')
      expect(writes.join('')).not.toContain('STALE_ACK')
      expect(writes.join('')).toContain('LIVE_ACK')
      expect(writes.findIndex((data) => data.includes('LIVE_ACK'))).toBeGreaterThan(
        writes.indexOf('SUCCESSOR_FRAME')
      )
      expect(session.pane.terminal.cols).toBe(PANE_COLS)
      expect(session.transport.resize).not.toHaveBeenCalledWith(2, 1)
    } finally {
      finishOldWrite?.()
      session.dispose()
    }
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
