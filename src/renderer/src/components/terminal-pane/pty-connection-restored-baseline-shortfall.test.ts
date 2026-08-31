import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
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

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

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

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

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
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

/** Mode/attribute rehydration only — the shape a model emulator serializes when
 *  a seed or hydration write never landed and it holds no cell content. */
const BLANK_MODEL_IMAGE = '\x1b[0m\x1b[?25h\x1b[?7h'

describe('restored snapshot baseline shortfall (STA-5179)', () => {
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

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function writtenData(pane: ReturnType<typeof createPane>): string {
    return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
  }

  async function revealPaneWithModelSnapshot(snapshot: {
    data: string
    seq: number
    pendingDeliveryStartSeq?: number
    scrollbackAnsi?: string
  }): Promise<{
    pane: ReturnType<typeof createPane>
    dataCallback: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    getMainBufferSnapshot: ReturnType<typeof vi.fn>
  }> {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      terminalMainSideEffectAuthority: true
    } as StoreState['settings']
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: true }
      }) as never
    )
    await flushAsyncTicks(6)
    const transportOptions = createdTransportOptions.at(-1) as {
      onPtySpawn?: (ptyId: string) => void
    }
    transportOptions.onPtySpawn?.('pty-id')

    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      cols: 100,
      rows: 30,
      ...snapshot
    })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'pending-cap',
      markerSeq: snapshot.seq
    })
    await flushAsyncTicks(20)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    pane.terminal.write.mockClear()
    return {
      pane,
      dataCallback: capturedDataCallback.current!,
      getMainBufferSnapshot
    }
  }

  it('recovers the backlog a blank snapshot claimed to have painted', async () => {
    // The model over-reports: seq 2_472 with no cell content behind it. Every
    // chunk carrying the missing tail sits at or below that seq, so the old
    // baseline dropped all of it as duplicates with nothing left to re-send.
    const { pane, dataCallback } = await revealPaneWithModelSnapshot({
      data: BLANK_MODEL_IMAGE,
      seq: 2_472,
      pendingDeliveryStartSeq: 2_400
    })

    dataCallback('TAIL-INSIDE-WINDOW', { seq: 2_460, rawLength: 18 })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).toContain('TAIL-INSIDE-WINDOW')

    // Straddling the claimed baseline: the whole chunk is recovered, not sliced.
    dataCallback('TAIL-STRADDLING', { seq: 2_475, rawLength: 15 })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).toContain('TAIL-STRADDLING')

    // An idle shell never re-sends: no further restore is needed to heal.
    dataCallback('LIVE-AFTER-BASELINE', { seq: 2_494, rawLength: 19 })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).toContain('LIVE-AFTER-BASELINE')
  })

  it('recovers the backlog when only scrollback-less blank content was painted', async () => {
    const { pane, dataCallback } = await revealPaneWithModelSnapshot({
      data: '\x1b[H\x1b[2J',
      scrollbackAnsi: '   \r\n',
      seq: 900
    })

    dataCallback('BLANK-WITH-WHITESPACE-SCROLLBACK', {
      seq: 880,
      rawLength: 32
    })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).toContain('BLANK-WITH-WHITESPACE-SCROLLBACK')
  })

  it('still suppresses backlog duplicates behind a snapshot that painted content', async () => {
    // Regression guard for the normal path: a snapshot with real cell content
    // keeps its drop-everything baseline, so the ACK backlog stays suppressed.
    const { pane, dataCallback } = await revealPaneWithModelSnapshot({
      data: 'restored snapshot\r\n',
      seq: 2_472,
      pendingDeliveryStartSeq: 2_400
    })

    dataCallback('COVERED-DUPLICATE', { seq: 2_460, rawLength: 17 })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).not.toContain('COVERED-DUPLICATE')

    // Only the post-baseline remainder of a straddling chunk is written.
    dataCallback('ABCDEFGHIJKLMNOPQRSTU', { seq: 2_478, rawLength: 21 })
    await flushAsyncTicks(8)
    expect(writtenData(pane)).toContain('PQRSTU')
    expect(writtenData(pane)).not.toContain('ABCDEF')
  })
})
