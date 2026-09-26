import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  LEAF_1,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
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

const PANE_KEY = `tab-recovered:${LEAF_1}`

function dormantRecoveryRecord() {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-recovered',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    origin: 'recovery',
    recovery: { importKey: 'import-1', sourcePaneKey: 'src:leaf' }
  }
}

function publishStore(next: Partial<StoreState>): void {
  mockStoreState = { ...mockStoreState, ...next }
  for (const listener of storeSubscribers) {
    listener(mockStoreState)
  }
}

describe('dormant recovered sessions keep their pane cold', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-recovered', ptyId: null, generation: 0 }] },
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: dormantRecoveryRecord() }
    }
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function mountRecoveredPane(): Promise<{
    transport: MockTransport
    binding: { dispose: () => void }
  }> {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const deps = createDeps({ tabId: 'tab-recovered', isVisibleRef: { current: true } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const binding = connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()
    return { transport, binding }
  }

  it('starts no PTY for an open pane, even once Resume claims the record', async () => {
    const { transport } = await mountRecoveredPane()
    expect(transport.connect).not.toHaveBeenCalled()

    publishStore({ sleepingAgentSessionsByPaneKey: {} })
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('reattaches to the PTY Resume bound to the leaf instead of spawning a shell', async () => {
    const { transport } = await mountRecoveredPane()
    publishStore({ sleepingAgentSessionsByPaneKey: {} })

    publishStore({
      terminalLayoutsByTabId: {
        'tab-recovered': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'wt-1@@resumed' }
        }
      }
    })
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'wt-1@@resumed' })
    )
  })

  it('leaves a Resume remount to the remounted pane', async () => {
    const { transport } = await mountRecoveredPane()

    publishStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-recovered', ptyId: null, generation: 1 }] },
      terminalLayoutsByTabId: {
        'tab-recovered': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'wt-1@@resumed' }
        }
      }
    })
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('spawns a plain shell after Start shell instead releases the pane', async () => {
    const { transport } = await mountRecoveredPane()
    const { releaseDormantRecoveryPaneToShell } =
      await import('@/lib/dormant-recovery-shell-release')
    publishStore({ sleepingAgentSessionsByPaneKey: {} })

    releaseDormantRecoveryPaneToShell(PANE_KEY)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() })
    )
  })

  it('drops its waits when the pane is disposed', async () => {
    const { transport, binding } = await mountRecoveredPane()
    const { releaseDormantRecoveryPaneToShell } =
      await import('@/lib/dormant-recovery-shell-release')

    binding.dispose()
    releaseDormantRecoveryPaneToShell(PANE_KEY)
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(storeSubscribers).toHaveLength(0)
  })
})
