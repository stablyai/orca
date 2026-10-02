import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
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

describe('connectPanePty process-exit retirement', () => {
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

  async function connectRestoredPane(
    ptyId: string,
    visible: boolean
  ): Promise<{ cacheKey: string; binding: { sampleForegroundAgentOnFocus: () => void } }> {
    const { connectPanePty } = await import('./pty-connection')
    const tabId = `tab-${ptyId}`
    const transport = createMockTransport(ptyId)
    transport.getPtyId.mockImplementation(() => ptyId)
    transport.connect.mockImplementation(async () => null)
    transportFactoryQueue.push(transport)
    const deps = createDeps({
      tabId,
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: ptyId },
      isVisibleRef: { current: visible }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectPanePty returns the pane binding, which exposes sampleForegroundAgentOnFocus.
    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      deps as never
    ) as unknown as { sampleForegroundAgentOnFocus: () => void }
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks(20)
    return { cacheKey: makePaneKey(tabId, LEAF_1), binding }
  }

  it('retires a hand-typed Codex read in a pane without command marks once it exits', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-unmarked-codex-exit'
    let foreground: string | null = 'codex'
    let children = true
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
    vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => children)

    const { cacheKey, binding } = await connectRestoredPane(ptyId, true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toMatchObject({
      agent: 'codex',
      agentEvidence: 'process-read'
    })

    foreground = 'zsh'
    children = false
    await vi.advanceTimersByTimeAsync(10_000)

    expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
      agent: null,
      shellForeground: false
    })
    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(cacheKey)

    // Codex typed again in the same unmarked pane: the next sample must identify it.
    foreground = 'codex'
    children = true
    binding.sampleForegroundAgentOnFocus()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toMatchObject({
      agent: 'codex',
      agentEvidence: 'process-read'
    })
  })
})
