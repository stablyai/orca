// A live agent's reattach image must keep its modes even when the separately published pane title lags it.
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  terminalWriteText,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { PtyReplayDataMeta } from './pty-transport-types'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
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

const PANE_COLS = 120
const PANE_ROWS = 40
// Normal-buffer image whose live process armed mouse and focus reporting.
const LIVE_AGENT_IMAGE = 'agent output\r\n\x1b[?1003h\x1b[?1006h\x1b[?1004h'
const MOUSE_DISARM = '\x1b[?1003l'

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

async function connectRemotePane(): Promise<{
  operations: { kind: 'resize' | 'write'; value: string }[]
  pane: ReturnType<typeof createPane>
  transport: MockTransport
  replay: (data: string, meta?: PtyReplayDataMeta) => void
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
  pane.terminal.write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
    data = terminalWriteText(data)
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
  const disposable = connectPanePty(...mockPanePtyArgs(pane, manager, createDeps()))
  await flushAsyncTicks(6)
  transport.resize.mockClear()

  return {
    operations,
    pane,
    transport,
    replay: (data, meta) => captured.current?.(data, meta),
    dispose: () => disposable.dispose()
  }
}

describe('reattach image title', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function epilogueAfterImage(
    storeTitle: string,
    imageTitle: string | undefined
  ): Promise<string> {
    const session = await connectRemotePane()
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: storeTitle } }
    session.replay(LIVE_AGENT_IMAGE, {
      snapshotCols: PANE_COLS,
      snapshotRows: PANE_ROWS,
      ...(imageTitle !== undefined ? { lastTitle: imageTitle } : {})
    })
    await flushAsyncTicks(20)
    const imageIndex = session.operations.findIndex(
      (operation) => operation.kind === 'write' && operation.value.includes(LIVE_AGENT_IMAGE)
    )
    expect(imageIndex).toBeGreaterThanOrEqual(0)
    session.dispose()
    return session.operations
      .slice(imageIndex + 1)
      .map((operation) => (operation.kind === 'write' ? operation.value : ''))
      .join('')
  }

  it("keeps a live agent's modes when the published title still shows the tab default", async () => {
    expect(await epilogueAfterImage('Terminal 1', 'Claude working')).not.toContain(MOUSE_DISARM)
  })

  it('disarms a plain program the published title still names as an agent', async () => {
    expect(await epilogueAfterImage('Claude working', 'vim')).toContain(MOUSE_DISARM)
  })

  it('falls back to the published title when an older host sends no image title', async () => {
    expect(await epilogueAfterImage('Terminal 1', undefined)).toContain(MOUSE_DISARM)
  })
})
