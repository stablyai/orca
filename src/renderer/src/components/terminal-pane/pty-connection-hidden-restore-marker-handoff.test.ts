import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'

// STA-4869: unhide can emit after the retiring pane unregisters; keep main’s drop latch until a successor paints and acks. Drive the real renderer channel with a model of main’s gate, pinned by src/main/ipc/pty-hidden-delivery-gate.test.ts.

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

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const PTY_ID = 'pty-id'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const R6_MARKER = 'R6-LOST-c5e2'
const HIDDEN_CHUNK = 'hidden-agent-output\r\n'

type PaneDrive = {
  pane: MockPane
  deps: PaneConnectionDeps
  binding: { syncProcessTracking: () => void; dispose: () => void }
  deliver: (data: string, seq: number) => void
  setVisible: (visible: boolean) => void
  writtenChunks: () => string[]
}

/** Model main’s drop latch: drops arm it; re-mark/unhide preserve it; applied ack or teardown retires it. */
const mainDropLatch = {
  hidden: false,
  dropped: false,
  markHidden(): void {
    this.hidden = true
  },
  /** @returns whether main owes the renderer a restore marker. */
  recordDrop(): boolean {
    if (this.dropped) {
      return false
    }
    this.dropped = true
    return true
  },
  /** @returns droppedWhileHidden — read, not spent. */
  unmarkHidden(): boolean {
    this.hidden = false
    return this.dropped
  },
  /** consumeHiddenRendererPtyDropMemory: the renderer painted the snapshot. */
  consumeDropMemory(): void {
    this.dropped = false
  },
  reset(): void {
    this.hidden = false
    this.dropped = false
  }
}

/** Model IPC by delivering main’s restore marker one turn after hidden-state changes. */
async function wireMainGateToRendererChannel(): Promise<{
  markersDelivered: () => number
}> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  let markersDelivered = 0
  vi.mocked(window.api.pty.setHiddenRendererPty).mockImplementation(
    (id: string, hidden: boolean) => {
      if (hidden) {
        mainDropLatch.markHidden()
        return
      }
      if (!mainDropLatch.unmarkHidden()) {
        return
      }
      markersDelivered += 1
      // Emit-time seq advances with visible output between reveals; the episode does not.
      const markerSeq = 4096 + markersDelivered
      queueMicrotask(() => {
        _dispatchPtyModelRestoreNeededForTest({
          id,
          reason: 'unhide',
          markerSeq,
          hiddenDropEpisode: 1
        })
      })
    }
  )
  vi.mocked(window.api.pty.ackHiddenOutputRestoreApplied).mockImplementation(() => {
    mainDropLatch.consumeDropMemory()
  })
  return { markersDelivered: () => markersDelivered }
}

/** Main ingests the chunk into its model and drops the renderer copy. */
async function dropHiddenBytesInMain(): Promise<void> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  expect(mainDropLatch.hidden).toBe(true)
  if (mainDropLatch.recordDrop()) {
    _dispatchPtyModelRestoreNeededForTest({
      id: PTY_ID,
      reason: 'hidden-drop',
      markerSeq: 2048,
      hiddenDropEpisode: 1
    })
  }
  await flushAsyncTicks(6)
}

async function connectPane(visible: boolean): Promise<PaneDrive> {
  const transport = createMockTransport(PTY_ID)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: visible }
  })
  const binding = await connectMockPanePty(pane, createManager(1), deps)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    deps,
    binding,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (nextVisible) => {
      deps.isVisibleRef.current = nextVisible
    },
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

function observeDisclosure(drive: PaneDrive): {
  bannerWrites: number
  markerWrites: number
  disclosedOrRecovered: boolean
} {
  const written = drive.writtenChunks()
  const bannerWrites = written.filter((data) => data.includes(BANNER_FRAGMENT)).length
  const markerWrites = written.join('').split(R6_MARKER).length - 1
  return {
    bannerWrites,
    markerWrites,
    disclosedOrRecovered: bannerWrites > 0 || markerWrites === 1
  }
}

describe('hidden-output restore marker handoff (STA-4869 R6)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mainDropLatch.reset()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      terminalMainSideEffectAuthority: true
    }
    await installTerminalTestGlobals()
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: `${R6_MARKER}\r\n`,
      cols: 120,
      rows: 40,
      seq: 4096
    })
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    const { _resetPtyRendererDeliveryClaimsForTest } =
      await import('./pty-renderer-delivery-claims')
    _resetPtyRendererDeliveryClaimsForTest()
  })

  it('[mechanism] the renderer channel drops a marker with no registered handler and never replays it', async () => {
    const { registerPtyModelRestoreNeededHandler, _dispatchPtyModelRestoreNeededForTest } =
      await import('./pty-model-restore-channel')
    const retiringHandler = vi.fn()
    const unregister = registerPtyModelRestoreNeededHandler(PTY_ID, retiringHandler)
    unregister()

    _dispatchPtyModelRestoreNeededForTest({
      id: PTY_ID,
      reason: 'unhide',
      markerSeq: 4096
    })
    expect(retiringHandler).not.toHaveBeenCalled()

    // The replacement view registers a moment later: nothing is held for it.
    const replacementHandler = vi.fn()
    registerPtyModelRestoreNeededHandler(PTY_ID, replacementHandler)
    await flushAsyncTicks(6)
    expect(replacementHandler).not.toHaveBeenCalled()
  })

  it('[control] a revealed pane consumes the unhide marker and repaints from the model', async () => {
    const gate = await wireMainGateToRendererChannel()
    const drive = await connectPane(false)
    drive.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()

    drive.setVisible(true)
    drive.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(gate.markersDelivered()).toBe(1)
    expect(observeDisclosure(drive)).toMatchObject({ markerWrites: 1 })
    drive.binding.dispose()
  })

  it('[invariant] a hidden pane that retires must not spend the drop latch on a marker nobody receives', async () => {
    const gate = await wireMainGateToRendererChannel()
    const retiring = await connectPane(false)
    retiring.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    expect(vi.mocked(window.api.pty.setHiddenRendererPty)).toHaveBeenCalledWith(PTY_ID, true)

    // Retirement unregisters the pane before its last hidden-claim release makes main emit a marker.
    retiring.binding.dispose()
    await flushAsyncTicks(20)
    expect(gate.markersDelivered()).toBe(1)

    // The replacement pane binds the same PTY while visible.
    const replacement = await connectPane(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    // Main retains the bytes; the replacement owes either snapshot recovery or a loss banner.
    const disclosure = {
      ...observeDisclosure(replacement),
      modelSnapshotRequests: vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length
    }
    expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
    expect(
      disclosure.disclosedOrRecovered,
      `hidden output was neither reconciled nor disclosed after remount: ${JSON.stringify(disclosure)}`
    ).toBe(true)
    replacement.binding.dispose()
  })

  it('[fix] the remount re-emits the unhide marker and the applied ack retires the latch', async () => {
    const gate = await wireMainGateToRendererChannel()
    const retiring = await connectPane(false)
    retiring.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    retiring.binding.dispose()
    await flushAsyncTicks(20)
    expect(gate.markersDelivered()).toBe(1)

    const replacement = await connectPane(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    // Unreceived markers must leave the latch armed; only the successor’s healing paint consumes it.
    expect(gate.markersDelivered()).toBe(2)
    expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
    expect(observeDisclosure(replacement)).toMatchObject({ markerWrites: 1 })
    expect(mainDropLatch.dropped).toBe(false)

    // No marker storm: hide/reveal cycles after consumption ask for nothing.
    const snapshotRequests = vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length
    replacement.setVisible(false)
    replacement.binding.syncProcessTracking()
    replacement.setVisible(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(gate.markersDelivered()).toBe(2)
    expect(vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length).toBe(snapshotRequests)
    replacement.binding.dispose()
  })

  it('[fix] acks only the drop episode its snapshot was requested for', async () => {
    const snapshot = { data: `${R6_MARKER}\r\n`, cols: 120, rows: 40, seq: 4096 }
    const served = createDeferred<typeof snapshot | null>()
    let servedCalls = 0
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockImplementation(async () => {
      servedCalls += 1
      return servedCalls === 1 ? await served.promise : snapshot
    })
    await wireMainGateToRendererChannel()
    const drive = await connectPane(false)
    drive.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    drive.setVisible(true)
    drive.binding.syncProcessTracking()
    await flushAsyncTicks(10)
    expect(servedCalls).toBe(1)

    // A newer episode is reported while the first snapshot is still in flight.
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: PTY_ID,
      reason: 'hidden-drop',
      markerSeq: 8192,
      hiddenDropEpisode: 2
    })
    served.resolve(snapshot)
    await flushAsyncTicks(30)

    // The older snapshot may predate episode 2's bytes, so it can only retire episode 1.
    const acks = vi.mocked(window.api.pty.ackHiddenOutputRestoreApplied).mock.calls
    expect(acks[0]).toEqual([PTY_ID, 1])
    expect(acks.slice(1).every(([, episode]) => episode === 2)).toBe(true)
    drive.binding.dispose()
  })

  it('[fix] a snapshot served into a disposing pane leaves the latch armed for the remount', async () => {
    // Dispose during multi-MB snapshot serialization to model a tab/split switch or renderer reload.
    const snapshot = {
      data: `${R6_MARKER}\r\n`,
      cols: 120,
      rows: 40,
      seq: 4096
    }
    const served = createDeferred<typeof snapshot | null>()
    let servedCalls = 0
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockImplementation(async () => {
      servedCalls += 1
      return servedCalls === 1 ? await served.promise : snapshot
    })
    const gate = await wireMainGateToRendererChannel()
    const retiring = await connectPane(false)
    retiring.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    retiring.setVisible(true)
    retiring.binding.syncProcessTracking()
    await flushAsyncTicks(10)
    expect(servedCalls).toBe(1)

    retiring.binding.dispose()
    served.resolve(snapshot)
    await flushAsyncTicks(20)

    // Nobody painted those bytes, so main still owes the next view a marker.
    expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()
    expect(mainDropLatch.dropped).toBe(true)

    const replacement = await connectPane(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(gate.markersDelivered()).toBeGreaterThanOrEqual(2)
    expect(observeDisclosure(replacement)).toMatchObject({
      bannerWrites: 0,
      markerWrites: 1
    })
    expect(mainDropLatch.dropped).toBe(false)
    replacement.binding.dispose()
  })

  it('[fix] a permanently refused source discloses the gap once across repeated reveals', async () => {
    // Deduplicate disclosed gaps despite repeated unhide markers, or every reveal re-fetches and re-banners historical loss.
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue(null)
    const gate = await wireMainGateToRendererChannel()
    const drive = await connectPane(false)
    drive.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()

    vi.useFakeTimers()
    try {
      drive.setVisible(true)
      drive.binding.syncProcessTracking()
      await vi.advanceTimersByTimeAsync(5_000)
      await flushAsyncTicks(20)
      expect(observeDisclosure(drive)).toMatchObject({ bannerWrites: 1 })
      const snapshotsAtDisclosure = vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls
        .length

      for (let cycle = 0; cycle < 4; cycle += 1) {
        // Ordinary visible output between reveals is not a new hidden drop.
        drive.deliver(`visible-${cycle}\r\n`, 8192 + cycle)
        drive.setVisible(false)
        drive.binding.syncProcessTracking()
        await vi.advanceTimersByTimeAsync(1_000)
        await flushAsyncTicks(20)
        drive.setVisible(true)
        drive.binding.syncProcessTracking()
        await vi.advanceTimersByTimeAsync(5_000)
        await flushAsyncTicks(20)
      }

      // Every reveal re-emits main's marker; none of them re-open the same gap.
      expect(gate.markersDelivered()).toBeGreaterThan(1)
      expect(observeDisclosure(drive)).toMatchObject({ bannerWrites: 1 })
      expect(vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length).toBe(
        snapshotsAtDisclosure
      )
    } finally {
      vi.useRealTimers()
    }
    drive.binding.dispose()
  })
})
