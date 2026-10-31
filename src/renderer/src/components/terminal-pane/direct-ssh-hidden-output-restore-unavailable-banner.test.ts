import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
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

// Direct-SSH null snapshots are unverifiable, not lost output; exercise main-buffer recovery with bounded retries like remote-runtime panes.

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)
const toastInfo = vi.fn()
const notifyCodexPaneBoundForStaleSweep = vi.fn()

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
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

const SSH_PTY_ID = 'ssh:coder-ws@@pty-1'
// Overflow the 2MB hidden queue to require main-model restore.
const HIDDEN_BYTES = 'x'.repeat(2 * 1024 * 1024 + 1)
const LIVE_AGENT_CHUNK = 'LIVE_AGENT_CHUNK\r\n'
const HOST_SNAPSHOT_MARKER = 'HOST_SNAPSHOT_HIDDEN_AGENT_CONTENT'
const HOST_SNAPSHOT = {
  data: `${HOST_SNAPSHOT_MARKER}\r\n`,
  cols: 120,
  rows: 40,
  seq: HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length,
  source: 'headless'
}
const BANNER_FRAGMENT = 'main recovery was unavailable'

type HostSnapshot = typeof HOST_SNAPSHOT

type SshPaneDrive = {
  transport: MockTransport
  pane: ReturnType<typeof createPane>
  deps: ReturnType<typeof buildPaneConnectionDeps>
  disposable: { dispose: () => void }
  deliver: (data: string, seq: number) => void
  writtenChunks: () => string[]
}

function stubMainBufferSnapshot(
  impl: () => Promise<HostSnapshot | null>
): ReturnType<typeof vi.fn> {
  const getMainBufferSnapshot = vi.fn(impl)
  ;(window.api.pty as unknown as Record<string, unknown>).getMainBufferSnapshot =
    getMainBufferSnapshot
  return getMainBufferSnapshot
}

async function connectHiddenDirectSshPane(): Promise<SshPaneDrive> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(SSH_PTY_ID)
  const capturedDataCallback: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    capturedDataCallback.current = callbacks?.onData ?? null
    return SSH_PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: false }
  })
  const disposable = connectPanePty(pane as never, manager as never, deps as never)
  await flushAsyncTicks(6)
  expect(capturedDataCallback.current).not.toBeNull()
  return {
    transport,
    pane,
    deps,
    disposable,
    deliver: (data, seq) => capturedDataCallback.current?.(data, { seq, rawLength: data.length }),
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

function driveHiddenBacklogThenReveal(drive: SshPaneDrive): void {
  drive.deliver(HIDDEN_BYTES, HIDDEN_BYTES.length)
  ;(drive.deps.isVisibleRef as { current: boolean }).current = true
  drive.deliver(LIVE_AGENT_CHUNK, HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length)
}

async function advanceThroughNullRetryBudget(): Promise<void> {
  for (let retry = 0; retry < 3; retry++) {
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)
  }
}

async function allowSelfHealWindow(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(500)
    await flushAsyncTicks(20)
  }
}

function observeFinalPaneState(drive: SshPaneDrive): {
  rawHiddenBacklogWritten: boolean
  liveAgentChunkWritten: boolean
  unavailableBannerWritten: boolean
  hiddenOutputRecoveredFromHostSnapshot: boolean
} {
  const joined = drive.writtenChunks().join('')
  return {
    rawHiddenBacklogWritten: joined.includes('x'.repeat(1024)),
    liveAgentChunkWritten: joined.includes('LIVE_AGENT_CHUNK'),
    unavailableBannerWritten: joined.includes(BANNER_FRAGMENT),
    hiddenOutputRecoveredFromHostSnapshot: joined.includes(HOST_SNAPSHOT_MARKER)
  }
}

describe('direct-SSH hidden-output restore abandonment', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
    // The reporter's client is WSL2, but the banner path is platform-independent;
    // pin darwin so the Windows synchronized-output scan stays out of the writes.
    ;(window.api.platform as unknown as Record<string, unknown>).get = vi.fn(() => ({
      platform: 'darwin',
      osRelease: '25.0.0'
    }))
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('[invariant] must not declare recovery unavailable when the SSH host snapshot is one retry tick away', async () => {
    const getMainBufferSnapshot: ReturnType<typeof vi.fn> = stubMainBufferSnapshot(async () =>
      getMainBufferSnapshot.mock.calls.length <= 4 ? null : HOST_SNAPSHOT
    )
    const drive = await connectHiddenDirectSshPane()
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

    await advanceThroughNullRetryBudget()
    await allowSelfHealWindow()

    expect(observeFinalPaneState(drive)).toEqual({
      rawHiddenBacklogWritten: false,
      liveAgentChunkWritten: true,
      unavailableBannerWritten: false,
      hiddenOutputRecoveredFromHostSnapshot: true
    })
    drive.disposable.dispose()
  })

  it('[invariant] must not turn a merely-slow SSH host snapshot into a loss banner and a permanent scrollback gap', async () => {
    const slowSnapshot = createDeferred<HostSnapshot>()
    const getMainBufferSnapshot = stubMainBufferSnapshot(async () => HOST_SNAPSHOT)
    getMainBufferSnapshot.mockReturnValueOnce(slowSnapshot.promise)
    const drive = await connectHiddenDirectSshPane()
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)
    slowSnapshot.resolve(HOST_SNAPSHOT)
    await flushAsyncTicks(20)
    await allowSelfHealWindow()

    expect(observeFinalPaneState(drive)).toEqual({
      rawHiddenBacklogWritten: false,
      liveAgentChunkWritten: true,
      unavailableBannerWritten: false,
      hiddenOutputRecoveredFromHostSnapshot: true
    })
    drive.disposable.dispose()
  })

  it('[invariant] a permanently silent SSH host banners once after a bounded number of re-arms and then stops requesting', async () => {
    const getMainBufferSnapshot = stubMainBufferSnapshot(async () => null)
    const drive = await connectHiddenDirectSshPane()
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    await advanceThroughNullRetryBudget()

    expect(drive.writtenChunks().join('')).toContain('LIVE_AGENT_CHUNK')

    for (let step = 0; step < 6; step += 1) {
      await allowSelfHealWindow()
    }
    const bannerCount = drive
      .writtenChunks()
      .filter((data) => data.includes(BANNER_FRAGMENT)).length
    expect(bannerCount).toBe(1)
    const settledRequests = getMainBufferSnapshot.mock.calls.length
    expect(settledRequests).toBeGreaterThan(4)
    expect(settledRequests).toBeLessThan(40)

    for (let step = 0; step < 4; step += 1) {
      await allowSelfHealWindow()
    }
    expect(getMainBufferSnapshot.mock.calls.length).toBe(settledRequests)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT)).length).toBe(1)
    drive.disposable.dispose()
  })

  // Live bytes do not prove snapshot recovery is available; continuous output must not refresh a spent re-arm budget.
  it('[invariant] continuous live output on a silent SSH host cannot refresh the re-arm budget into a repaint loop', async () => {
    const getMainBufferSnapshot = stubMainBufferSnapshot(async () => null)
    const drive = await connectHiddenDirectSshPane()
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    await advanceThroughNullRetryBudget()

    let seq = HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length
    for (let step = 0; step < 60; step += 1) {
      const chunk = `LIVE_TICK_${step}\r\n`
      seq += chunk.length
      drive.deliver(chunk, seq)
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)
    }

    const joined = drive.writtenChunks().join('')
    expect(joined).toContain('LIVE_TICK_0')
    expect(joined).toContain('LIVE_TICK_59')
    expect(joined.split(BANNER_FRAGMENT).length - 1).toBe(1)
    const settledRequests = getMainBufferSnapshot.mock.calls.length
    expect(settledRequests).toBeLessThan(40)

    for (let step = 0; step < 30; step += 1) {
      const chunk = `LIVE_TAIL_${step}\r\n`
      seq += chunk.length
      drive.deliver(chunk, seq)
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)
    }
    expect(getMainBufferSnapshot.mock.calls.length).toBe(settledRequests)
    expect(drive.writtenChunks().join('').split(BANNER_FRAGMENT).length - 1).toBe(1)
    drive.disposable.dispose()
  })

  // Reset spent tolerance after its banner so one long outage cannot permanently disable later recovery episodes.
  it('[invariant] a spent re-arm budget must not leave the SSH pane at zero tolerance for its next hidden episode', async () => {
    const revivedSnapshot = createDeferred<HostSnapshot>()
    let hostIsSilent = true
    stubMainBufferSnapshot(async () => (hostIsSilent ? null : revivedSnapshot.promise))
    const drive = await connectHiddenDirectSshPane()
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    await advanceThroughNullRetryBudget()
    for (let step = 0; step < 6; step += 1) {
      await allowSelfHealWindow()
    }
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)

    // The same PTY recovers, but its next snapshot still arrives after the foreground deadline.
    hostIsSilent = false
    let seq = HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length
    ;(drive.deps.isVisibleRef as { current: boolean }).current = false
    seq += HIDDEN_BYTES.length
    drive.deliver(HIDDEN_BYTES, seq)
    ;(drive.deps.isVisibleRef as { current: boolean }).current = true
    seq += LIVE_AGENT_CHUNK.length
    drive.deliver(LIVE_AGENT_CHUNK, seq)
    await flushAsyncTicks(20)
    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)
    revivedSnapshot.resolve(HOST_SNAPSHOT)
    await flushAsyncTicks(20)
    await allowSelfHealWindow()

    const joined = drive.writtenChunks().join('')
    expect(joined.split(BANNER_FRAGMENT).length - 1).toBe(1)
    expect(joined).toContain(HOST_SNAPSHOT_MARKER)
    drive.disposable.dispose()
  })
})
