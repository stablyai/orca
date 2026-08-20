/**
 * STA-4593 incident: typing into a visible remote Codex pane produced no
 * visible output until the user switched workspaces away and back. The host
 * DROPS output while a stream is paused yet keeps accepting input, and every
 * hide→show cycle heals the pane with an unconditional snapshot repaint —
 * which is why the switch "fixed" it and why nothing ever logged an error.
 *
 * Invariant under test: a VISIBLE pane must never be left with a paused output
 * intent. The pause bit must be re-derived from live visibility whenever the
 * chance to sync it was missed.
 *
 * Causal boundary: syncHiddenRendererPtyDelivery issues setOutputPaused only
 * when canUseHiddenOutputSnapshot(ptyId) — which requires
 * transport.getPtyId() === ptyId. During a stream rebind getPtyId() is
 * transiently null, so a reveal that lands in that window is a silent no-op:
 * desiredOutputPaused stays true, the transport replays it verbatim onto the
 * recovered stream, the host drops all output, and the stall watchdog never
 * arms on a paused stream. Nothing re-derives the bit on onConnect or
 * onStreamRecovered.
 *
 * Rig: the hidden-backlog-snapshot suite's mock-transport harness; fake
 * visibility flips drive the real connectPanePty binding.
 */
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
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
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

    // The stream drops and a resubscribe is in flight: the transport has no
    // bound PTY id during the rebind window.
    transport.getPtyId.mockImplementation(() => null)

    // The user switches back while the rebind is in flight. The sync cannot
    // reach the host right now — the defect is that nothing ever retries it.
    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncProcessTracking()

    // The rebind completes: the transport re-derives the same pane and reports
    // the recovered stream. Production replays desiredOutputPaused onto the new
    // stream verbatim, so unless this moment re-derives pause-from-visibility,
    // the host keeps dropping every byte for a pane the user is looking at —
    // while its input keeps being accepted, and the paused stream never arms
    // the stall watchdog.
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

    // When the recovery subscribe's push snapshot carried content — the common
    // case — the transport fires ONLY onConnect (onStreamRecovered is gated on
    // an empty snapshot). onConnect must therefore re-derive the bit by itself.
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
