import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPanePty } from './pty-connection'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

const {
  notifyCodexPaneBoundForStaleSweep,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo
} = vi.hoisted(() => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let storeFixture: Awaited<ReturnType<typeof createInitialStoreState>>
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store', () => {
  return {
    useAppStore: {
      get getState() {
        return storeFixture.store.getState
      },
      get setState() {
        return storeFixture.store.setState
      },
      subscribe: (listener: (state: StoreState) => void) => {
        storeSubscribers.push(listener)
        return () => {
          storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
        }
      }
    }
  }
})

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

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

describe('connectPanePty split cwd resolution', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    storeFixture = await createInitialStoreState()
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    storeFixture.dispose()
    await restoreTerminalTestGlobals()
  })

  it('waits for inherited cwd before fresh spawn and applies the resolved directory', async () => {
    const cwd = createDeferred<string>()
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      buildPaneConnectionDeps(storeFixture, { cwdPromise: cwd.promise })
    )
    await flushAsyncTicks(20)

    expect(createdTransportOptions[0]?.bufferInputUntilConnect).toBe(true)
    expect(transport.connect).not.toHaveBeenCalled()

    cwd.resolve('/resolved/source-cwd')
    await flushAsyncTicks(20)

    expect(createdTransportOptions[0]?.cwd).toBe('/resolved/source-cwd')
    expect(transport.connect).toHaveBeenCalledOnce()
    binding.dispose()
  })

  it('cancels the pending spawn when the split closes before cwd resolution', async () => {
    const cwd = createDeferred<string>()
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      buildPaneConnectionDeps(storeFixture, { cwdPromise: cwd.promise })
    )
    await flushAsyncTicks(20)
    binding.dispose()

    cwd.resolve('/resolved/too-late')
    await flushAsyncTicks(20)

    expect(transport.connect).not.toHaveBeenCalled()
  })
})
