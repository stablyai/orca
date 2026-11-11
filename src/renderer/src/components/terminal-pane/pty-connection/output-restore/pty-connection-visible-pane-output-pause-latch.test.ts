// STA-4593: reveal during a null-ID rebind cannot unpause immediately; reconnect must rederive pause intent from live visibility or the host drops visible output indefinitely. Test both connect and stream-recovery callbacks.
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

const { scheduleRuntimeGraphSync, shouldSeedCacheTimerOnInitialTitle } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false)
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/store/index', () => ({
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

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('../../pty-transport/ipc/pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('../../pty-transport/remote-runtime/remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
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
  const { connectPanePty } = await import('../connect-pane-pty')
  const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
    '@/lib/agent-status/aggregation/worktree-agent-status'
  )
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
    bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
  )
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
