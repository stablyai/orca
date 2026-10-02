import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
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
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
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

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('command-finished cleanup when the shell check cannot answer', () => {
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

  describe.each([
    { label: 'unanswered local read', ptyId: 'pty-omp-unanswered', fails: false },
    { label: 'failed local read', ptyId: 'pty-omp-failed', fails: true },
    { label: 'unavailable SSH host', ptyId: 'ssh:conn@@pty-omp-unavailable', fails: false }
  ])('$label', ({ ptyId, fails }) => {
    it.each(['working', 'done'] as const)(
      'keeps %s OMP status through repeated command finishes without a launch record',
      async (state) => {
        vi.useFakeTimers()
        const { connectPanePty } = await import('./pty-connection')
        vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => {
          if (fails) {
            throw new Error('execution host unavailable')
          }
          return null
        })
        const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
        const tabId = 'tab-omp-unanswered'
        const paneKey = makePaneKey(tabId, LEAF_1)
        const transport = createMockTransport(ptyId)
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            dataCallbackRef.current = callbacks.onData ?? null
            return { id: ptyId }
          }
        )
        transportFactoryQueue.push(transport)
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          paneKey,
          state,
          prompt: 'worker task',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'omp',
          terminalTitle: 'OMP',
          stateHistory: []
        }
        mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
          delete mockStoreState.agentStatusByPaneKey[key]
        })

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          createDeps({ tabId, isVisibleRef: { current: false } }) as never
        )
        await vi.advanceTimersByTimeAsync(20)
        await flushAsyncTicks()

        for (const bytes of ['\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07', '\x1b]133;D;0\x07']) {
          dataCallbackRef.current?.(bytes)
          await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
          await flushAsyncTicks()

          expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
            agentType: 'omp',
            state,
            prompt: 'worker task'
          })
          expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
        }
      }
    )
  })
})
