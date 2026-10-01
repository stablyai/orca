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

// Why: useCallback must pass through; no test here renders React.
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

// A process-lifetime producer (OpenCode 2 `opencode run`) posts the run's Done after the
// command-finished fact; the exited-agent drop must keep it, as it keeps a late hook Done.
describe('command-finished drop and a Done that lands after it', () => {
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

  async function connectRunPane(): Promise<{
    finishCommand: () => void
    setStatus: (state: 'working' | 'done') => void
    paneKey: string
  }> {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const { createTestStore } = await import('@/store/slices/store-test-helpers')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-opencode-run')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: 'pty-opencode-run' }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [
      createPane(1),
      createManager(1),
      createDeps({ isVisibleRef: { current: false } })
    ] as unknown as Parameters<typeof connectPanePty>
    connectPanePty(...args)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    const realStore = createTestStore()
    mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
      delete mockStoreState.agentStatusByPaneKey[key]
    })
    return {
      paneKey,
      finishCommand: () => dataCallbackRef.current?.('\x1b]133;D;0\x07'),
      setStatus: (state) => {
        realStore.getState().setAgentStatus(paneKey, { state, prompt: '', agentType: 'opencode' })
        mockStoreState.agentStatusByPaneKey[paneKey] =
          realStore.getState().agentStatusByPaneKey[paneKey]
      }
    }
  }

  it('keeps a Done that lands after the command-finished fact', async () => {
    const pane = await connectRunPane()
    pane.setStatus('working')

    pane.finishCommand()
    pane.setStatus('done')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(mockStoreState.agentStatusByPaneKey[pane.paneKey]).toMatchObject({ state: 'done' })
  })

  it('drops a Done that landed before the command-finished fact', async () => {
    const pane = await connectRunPane()
    pane.setStatus('working')
    pane.setStatus('done')

    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(pane.paneKey)
  })
})
