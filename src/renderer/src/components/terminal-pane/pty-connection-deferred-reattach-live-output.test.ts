import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { RESET_GRAPHIC_RENDITION } from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
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
  scheduleImagePasteWebglAtlasRecovery
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

describe('connectPanePty', () => {
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

  it('does not consume the sleeping record when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not resume the provider session when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('live-snapshot', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('drains live bytes after transport confirms an explicit reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { deliverTerminalDataWithDeferredCredit } =
      await import('@/lib/pane-manager/terminal-delivery-credit')
    const transport = createMockTransport('tab-pty')
    const acknowledgeLiveFrame = vi.fn()
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        // Why: the real dispatcher drains post-snapshot bytes as soon as spawn IPC resolves, before connect() returns.
        callbacks?.onReattachDetermined?.()
        deliverTerminalDataWithDeferredCredit(acknowledgeLiveFrame, () => {
          callbacks?.onData?.('post-snapshot-live')
        })
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    const snapshotIndex = writes.indexOf(`${RESET_GRAPHIC_RENDITION}authoritative-snapshot`)
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(writes).not.toContain('post-snapshot-live')
    for (let step = 0; step < 40; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    const liveIndex = writes.indexOf('post-snapshot-live')
    expect(liveIndex).toBeGreaterThan(snapshotIndex)
    expect(acknowledgeLiveFrame).toHaveBeenCalledOnce()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'tab-pty')
  })

  it('re-enforces follow intent after deferred reattach live output parses', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: (() => void)[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push(() => {
        if (data === 'post-snapshot-live') {
          pane.terminal.buffer.active.baseY = 200
          pane.terminal.buffer.active.viewportY = 100
        }
        callback?.()
      })
    })
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 30; index += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
      if (parseCallbacks.length === 0 && index > 5) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(200)
  })

  it('does not steal a newer user pin while deferred reattach output settles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: { data: string; run: () => void }[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push({
        data,
        run: () => {
          if (data === 'post-snapshot-live') {
            pane.terminal.buffer.active.baseY = 200
            pane.terminal.buffer.active.viewportY = 100
          }
          callback?.()
        }
      })
    })
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 40; index += 1) {
      const pending = parseCallbacks.shift()
      pending?.run()
      await flushAsyncTicks(4)
      if (pending?.data === 'post-snapshot-live') {
        pane.terminal.buffer.active.viewportY = 150
        markTerminalPinnedViewport(pane.terminal)
      }
      if (parseCallbacks.length === 0 && index > 8) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(150)
  })

  it('does not enforce a deferred viewport after the pane becomes hidden', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: { data: string; run: () => void }[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push({
        data,
        run: () => {
          if (data === 'post-snapshot-live') {
            pane.terminal.buffer.active.baseY = 200
            pane.terminal.buffer.active.viewportY = 100
          }
          callback?.()
        }
      })
    })
    const deps = createDeps({
      isVisibleRef: { current: true },
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 40; index += 1) {
      const pending = parseCallbacks.shift()
      pending?.run()
      await flushAsyncTicks(4)
      if (pending?.data === 'post-snapshot-live') {
        ;(deps.isVisibleRef as { current: boolean }).current = false
      }
      if (parseCallbacks.length === 0 && index > 8) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(100)
  })

  it('does not fresh-spawn after a dead deferred session delivers its buffered exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return 'unexpected-fresh-pty'
        }
        callbacks?.onData?.('dead-session-final-frame')
        return { id: sessionId, exitedBeforeAttach: true }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(writes).toContain('dead-session-final-frame')
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
  })

  // Why: Phase 6 deleted the hidden-skip grammar — every hidden chunk rides the background scheduler, none content-scanned.
  it('queues hidden PTY bytes on the background scheduler without per-chunk scanning', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    try {
      const hiddenChunks = [
        'plain hidden text\r\n',
        '\x1b[2J\x1b[Hcontrol redraw\r\n',
        '\x1b[2J\x1b[H╭ table 😀 ╮\r\n',
        '\x1b[?2026h| Sam Syntax | 😀 |\r\n\x1b[?2026l',
        '\x1b[?2026h\x1b[6n'
      ]
      for (const chunk of hiddenChunks) {
        capturedDataCallback.current?.(chunk)
      }

      // Background path defers writes; nothing is written synchronously.
      expect(pane.terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      // The drain may coalesce queued chunks into one write — assert content.
      const written = pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
      for (const chunk of hiddenChunks) {
        expect(written).toContain(chunk)
      }
      // No model restore is latched for bounded hidden output.
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
