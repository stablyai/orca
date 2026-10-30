// STA-4593: reveal during a null-ID rebind cannot unpause immediately; reconnect must rederive pause intent from live visibility or the host drops visible output indefinitely. Test both connect and stream-recovery callbacks.
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

const { scheduleRuntimeGraphSync, shouldSeedCacheTimerOnInitialTitle } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false)
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
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

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

const REMOTE_PTY_ID = 'remote:env-1@@terminal-1'

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

type Binding = { syncProcessTracking: () => void; dispose: () => void }

async function connectVisibleRemotePane(): Promise<{
  transport: MockTransport
  binding: Binding
  deps: ReturnType<typeof createDeps>
  callbacks: () => ConnectCallbacks
  pauseCalls: () => boolean[]
}> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(REMOTE_PTY_ID)
  transport.setOutputPaused = vi.fn(() => true)
  transport.serializeBuffer = vi.fn()
  const captured: { callbacks: ConnectCallbacks | null } = { callbacks: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
    captured.callbacks = callbacks
    return REMOTE_PTY_ID
  })
  transportFactoryQueue.push(transport)
  const deps = createDeps({ isVisibleRef: { current: true } })
  const binding = connectPanePty(
    createPane(1) as never,
    createManager(1) as never,
    deps as never
  ) as Binding
  await flushAsyncTicks(6)
  expect(captured.callbacks).not.toBeNull()
  return {
    transport,
    binding,
    deps,
    callbacks: () => captured.callbacks!,
    pauseCalls: () =>
      (transport.setOutputPaused as ReturnType<typeof vi.fn>).mock.calls.map(
        ([paused]) => paused as boolean
      )
  }
}

describe('remote pane output pause vs visibility', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('control: a hide/show cycle with a stable stream ends unpaused', async () => {
    const { binding, deps, pauseCalls } = await connectVisibleRemotePane()

    ;(deps.isVisibleRef as { current: boolean }).current = false
    binding.syncProcessTracking()
    expect(pauseCalls().at(-1)).toBe(true)
    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()

    expect(pauseCalls().at(-1)).toBe(false)
    binding.dispose()
  })

  it('red: a reveal that lands mid-rebind must still end with the visible pane unpaused', async () => {
    const { transport, binding, deps, callbacks, pauseCalls } = await connectVisibleRemotePane()

    // Hide the pane: the transport is asked to pause host output.
    ;(deps.isVisibleRef as { current: boolean }).current = false
    binding.syncProcessTracking()
    expect(pauseCalls().at(-1)).toBe(true)

    // Reveal during null-ID rebind cannot reach the host; reconnect must retry visibility sync.
    transport.getPtyId.mockImplementation(() => null)

    // The user switches back while the rebind is in flight. The sync cannot
    // reach the host right now — the defect is that nothing ever retries it.
    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()

    // Transport recovery replays pause intent verbatim, so it must first rederive it from visibility or drop watched output with no stall watchdog.
    transport.getPtyId.mockImplementation(() => REMOTE_PTY_ID)
    callbacks().onStreamRecovered?.()
    callbacks().onConnect?.()
    await flushAsyncTicks(6)

    expect(
      pauseCalls().at(-1),
      `a visible pane was left output-paused after a mid-rebind reveal (setOutputPaused calls: ${JSON.stringify(pauseCalls())})`
    ).toBe(false)
    binding.dispose()
  })

  it('red: a content-bearing recovery fires only onConnect, which must re-derive the pause bit alone', async () => {
    const { transport, binding, deps, callbacks, pauseCalls } = await connectVisibleRemotePane()

    ;(deps.isVisibleRef as { current: boolean }).current = false
    binding.syncProcessTracking()
    expect(pauseCalls().at(-1)).toBe(true)

    transport.getPtyId.mockImplementation(() => null)
    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()

    // Contentful recovery fires only onConnect; it must repair pause intent without onStreamRecovered.
    transport.getPtyId.mockImplementation(() => REMOTE_PTY_ID)
    callbacks().onConnect?.()
    await flushAsyncTicks(6)

    expect(
      pauseCalls().at(-1),
      `onConnect alone did not unpause a visible pane (setOutputPaused calls: ${JSON.stringify(pauseCalls())})`
    ).toBe(false)
    binding.dispose()
  })
})
