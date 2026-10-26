import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
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
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

// Without a recovered host image, idle differential TUIs need a real one-row resize then restoration; same-size SIGWINCH does not force Node repaint (#26887).

const scheduleRuntimeGraphSync = vi.fn()
let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState, subscribe: () => () => {} }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn }
})
const nextQueuedTransport = (): MockTransport => {
  const next = transportFactoryQueue.shift()
  if (!next) {
    throw new Error('No mock transport queued')
  }
  return next
}
vi.mock('./pty-transport', () => ({ createIpcPtyTransport: vi.fn(() => nextQueuedTransport()) }))
vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => nextQueuedTransport())
}))
vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const REMOTE_PTY_ID = 'remote:env-1@@terminal-agent-1'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const HOST_SNAPSHOT = {
  data: 'CURRENT_FRAME\r\n',
  cols: 120,
  rows: 40,
  seq: 10,
  source: 'headless'
}

type Outcome = { availability: Record<string, unknown>; snapshot: typeof HOST_SNAPSHOT | null }

type ReconnectedPane = {
  transport: MockTransport
  pane: ReturnType<typeof createPane>
  deps: ReturnType<typeof buildPaneConnectionDeps>
  dispose: () => void
  reconnectWithoutImage: () => void
  deliver: (data: string, seq: number) => void
  banners: () => number
  resizes: () => unknown[][]
}

async function connectVisibleRemotePane(
  outcome: (() => Promise<Outcome>) | Outcome,
  opts: { visible?: boolean } = {}
): Promise<ReconnectedPane> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(REMOTE_PTY_ID)
  transport.serializeBuffer = vi.fn()
  transport.serializeBufferOutcome = vi.fn(
    typeof outcome === 'function' ? outcome : async () => outcome
  )
  let onStreamRecovered: (() => void) | null = null
  let onData: ConnectCallbacks['onData'] | null = null
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    onStreamRecovered = callbacks?.onStreamRecovered ?? null
    onData = callbacks?.onData ?? null
    return REMOTE_PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: opts.visible ?? true }
  })
  const disposable = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
  await flushAsyncTicks(6)
  expect(onStreamRecovered).not.toBeNull()
  transport.resize.mockClear()
  return {
    transport,
    pane,
    deps,
    dispose: () => disposable.dispose(),
    reconnectWithoutImage: () => onStreamRecovered?.(),
    deliver: (data, seq) => onData?.(data, { seq, rawLength: data.length }),
    banners: () =>
      pane.terminal.write.mock.calls.filter(([data]) => String(data).includes(BANNER_FRAGMENT))
        .length,
    resizes: () => transport.resize.mock.calls
  }
}

const NUDGE = [
  [120, 39, { claim: true }],
  [120, 40, { claim: true }]
]

async function settle(ms: number): Promise<void> {
  for (let step = 0; step < ms / 500; step += 1) {
    await vi.advanceTimersByTimeAsync(500)
    await flushAsyncTicks(20)
  }
}

describe('a reconnected remote pane the host could not image', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
    Object.assign(window.api.platform, {
      get: vi.fn(() => ({ platform: 'darwin', osRelease: '25.0.0' }))
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await restoreTerminalTestGlobals()
  })

  it('control: a fresh host image repaints the pane without resizing the program', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'snapshot' },
      snapshot: HOST_SNAPSHOT
    })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)

    expect(drive.pane.terminal.write.mock.calls.map(([data]) => String(data)).join('')).toContain(
      'CURRENT_FRAME'
    )
    expect(drive.resizes()).toEqual([])
    drive.dispose()
  })

  it.each([
    [
      'too large for the replay limit',
      { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' }
    ],
    [
      'skipped by a host with no buffer',
      { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' }
    ],
    [
      'skipped while the host output overflowed',
      { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' }
    ]
  ])('asks the program to repaint when the image is %s', async (_label, availability) => {
    const drive = await connectVisibleRemotePane({ availability, snapshot: null })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(30_000)

    expect(drive.banners()).toBe(1)
    expect(drive.resizes()).toEqual(NUDGE)
    drive.dispose()
  })

  it('asks the program to repaint when the host never answers the snapshot request', async () => {
    const drive = await connectVisibleRemotePane(() =>
      Promise.reject(new Error('Remote terminal snapshot timed out.'))
    )
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(30_000)

    expect(drive.banners()).toBe(1)
    expect(drive.resizes()).toEqual(NUDGE)
    drive.dispose()
  })

  it('repaints a full-screen TUI on the alternate screen the same way', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    drive.pane.terminal.buffer.active.type = 'alternate'
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)

    expect(drive.resizes()).toEqual(NUDGE)
    drive.dispose()
  })

  it('holds the repaint for a hidden pane until it is revealed', async () => {
    const drive = await connectVisibleRemotePane(
      {
        availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
        snapshot: null
      },
      { visible: false }
    )
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)
    expect(drive.resizes()).toEqual([])

    // Revealed by the next live byte, as an idle agent's cursor blink or the user's typing would.
    ;(drive.deps.isVisibleRef as { current: boolean }).current = true
    drive.deliver('x', 11)
    await settle(5_000)
    expect(drive.resizes()).toEqual(NUDGE)
    drive.dispose()
  })

  it('leaves the size alone while a phone or another desktop holds it', async () => {
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    setFitOverride(REMOTE_PTY_ID, 'mobile-fit', 50, 30)
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)

    expect(drive.banners()).toBe(1)
    expect(drive.resizes()).toEqual([])
    drive.dispose()
  })

  it('grows a pane at the host minimum height instead of asking for the same clamped size', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    drive.pane.terminal.rows = 6
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)

    expect(drive.resizes()).toEqual([
      [120, 9, { claim: true }],
      [120, 6, { claim: true }]
    ])
    drive.dispose()
  })

  it('puts the row back once the host confirms the short grid, not when the client sent it', async () => {
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    for (let tick = 0; tick < 5 && drive.resizes().length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
      await flushAsyncTicks(20)
    }
    expect(drive.resizes()).toEqual([NUDGE[0]])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(drive.resizes()).toEqual([NUDGE[0]])

    setFitOverride(REMOTE_PTY_ID, 'desktop-fit', 120, 39)
    await vi.advanceTimersByTimeAsync(249)
    expect(drive.resizes()).toEqual([NUDGE[0]])
    await vi.advanceTimersByTimeAsync(1)
    expect(drive.resizes()).toEqual(NUDGE)
    drive.dispose()
  })

  it('does not take the size back from a viewer that claimed it mid-repaint', async () => {
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    for (let tick = 0; tick < 5 && drive.resizes().length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
      await flushAsyncTicks(20)
    }
    setFitOverride(REMOTE_PTY_ID, 'desktop-fit', 120, 39)
    setFitOverride(REMOTE_PTY_ID, 'remote-desktop-fit', 100, 30)
    await settle(5_000)

    expect(drive.resizes()).toEqual([NUDGE[0]])
    drive.dispose()
    expect(drive.resizes()).toEqual([NUDGE[0]])
  })

  it('does not nudge while the stream is still reconnecting', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    drive.transport.isConnected?.mockReturnValue(false)
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    await settle(5_000)

    expect(drive.banners()).toBe(1)
    expect(drive.resizes()).toEqual([])
    drive.dispose()
  })

  it('leaves a swapped-out PTY alone when its nudge is still pending', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    for (let tick = 0; tick < 5 && drive.resizes().length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
      await flushAsyncTicks(20)
    }
    expect(drive.resizes()).toEqual([NUDGE[0]])

    drive.transport.getPtyId.mockReturnValue('remote:env-1@@terminal-agent-2')
    await settle(5_000)
    expect(drive.resizes()).toEqual([NUDGE[0]])
    drive.dispose()
  })

  it('puts the row back when the pane unmounts mid-repaint', async () => {
    const drive = await connectVisibleRemotePane({
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    })
    vi.useFakeTimers()
    drive.reconnectWithoutImage()
    for (let tick = 0; tick < 5 && drive.resizes().length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
      await flushAsyncTicks(20)
    }
    expect(drive.resizes()).toEqual([NUDGE[0]])

    drive.dispose()
    expect(drive.resizes()).toEqual(NUDGE)
    await settle(1_000)
    expect(drive.resizes()).toEqual(NUDGE)
  })
})
