import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
  RESET_GRAPHIC_RENDITION,
} from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildReattachPaneTitleState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
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

function setReattachPaneTitle(title: string): void {
  mockStoreState = buildReattachPaneTitleState(mockStoreState, title)
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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

  // Why: the relay replay tail is raw bytes with no mode state; the attach-boundary
  // modes seed a tracker the replay advances, and the merged result re-arms the exact
  // modes (rehydrate) before the reset profile is chosen.
  describe('relay replay mode restore', () => {
    const REPLAY_RESTORE_MODES = {
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag' as const,
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: false,
      alternateScreen: true
    }

    const connectRelayReplayPane = async (
      connectResult: Record<string, unknown>
    ): Promise<{ pane: ReturnType<typeof createPane>; writes: string[] }> => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
        sessionId ? { id: sessionId, ...connectResult } : null
      )
      transportFactoryQueue.push(transport)
      setReattachPaneTitle('zsh')
      const pane = createPane(1)
      const writes: string[] = []
      pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
        writes.push(data)
        callback?.()
      }) as typeof pane.terminal.write
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(30)
      return { pane, writes }
    }

    it('rehydrates seeded modes after the replay body and keeps mouse via the alt profile', async () => {
      const { writes } = await connectRelayReplayPane({
        replay: 'plain replay tail without mode sequences',
        modes: REPLAY_RESTORE_MODES
      })
      const bodyIndex = writes.indexOf('plain replay tail without mode sequences')
      const rehydrateIndex = writes.findIndex((data) => data.includes('\x1b[?1002h'))
      expect(bodyIndex).toBeGreaterThanOrEqual(0)
      expect(rehydrateIndex).toBeGreaterThan(bodyIndex)
      expect(writes[rehydrateIndex]).toContain('\x1b[?1006h')
      expect(writes[rehydrateIndex]).toContain('\x1b[?2004h')
      const resetIndex = writes.indexOf(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE)
      expect(resetIndex).toBeGreaterThan(rehydrateIndex)
      expect(writes).not.toContain(POST_REPLAY_REATTACH_RESET)
    })

    it('follows an alt-screen exit inside the replay tail to the mouse-wiping profile', async () => {
      const { writes } = await connectRelayReplayPane({
        replay: 'tui closed\x1b[?1049l',
        modes: REPLAY_RESTORE_MODES
      })
      expect(writes).toContain(POST_REPLAY_REATTACH_RESET)
      expect(writes).not.toContain(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE)
    })

    it('keeps the legacy replay writes byte-for-byte when modes are absent', async () => {
      const { writes } = await connectRelayReplayPane({ replay: 'replay-payload' })
      expect(writes.filter((data) => data !== '')).toEqual([
        `${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`,
        'replay-payload',
        POST_REPLAY_REATTACH_RESET
      ])
    })

    it('still applies the full mode reset for a cold restore even when modes are present', async () => {
      const { writes } = await connectRelayReplayPane({
        replay: 'replay-payload',
        coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' },
        modes: REPLAY_RESTORE_MODES
      })
      expect(writes).toContain(POST_REPLAY_MODE_RESET)
      // Why: the owner process is dead — rehydrating its modes would arm mouse
      // reporting against the fresh shell that replaces it (#12101).
      expect(writes.some((data) => data.includes('\x1b[?1002h'))).toBe(false)
    })

    const connectPushReplayPane = async (): Promise<{
      pane: ReturnType<typeof createPane>
      writes: string[]
      replayCallback: {
        current:
          | ((
              data: string,
              meta?: {
                clearBeforeReplay?: boolean
                pendingEscapeTailAnsi?: string
                modes?: typeof REPLAY_RESTORE_MODES
              }
            ) => void)
          | null
      }
    }> => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment()
      const pane = createPane(1)
      const writes: string[] = []
      pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
        writes.push(data)
        callback?.()
      }) as typeof pane.terminal.write
      const transport = createMockTransport('remote:web-env-1@@pty-modes-push')
      const replayCallback: Awaited<ReturnType<typeof connectPushReplayPane>>['replayCallback'] = {
        current: null
      }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          replayCallback.current = callbacks.onReplayData ?? null
          return { id: 'remote:web-env-1@@pty-modes-push', replay: '' }
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      expect(replayCallback.current).toBeTypeOf('function')
      return { pane, writes, replayCallback }
    }

    it('applies push-path replay modes with rehydrate before reset and the escape tail last', async () => {
      const { writes, replayCallback } = await connectPushReplayPane()

      replayCallback.current?.('pushed replay tail', {
        modes: REPLAY_RESTORE_MODES,
        pendingEscapeTailAnsi: '\x1b[3'
      })
      await flushAsyncTicks(30)

      const clearIndex = writes.indexOf('\x1b[2J\x1b[3J\x1b[H')
      const bodyIndex = writes.indexOf('pushed replay tail')
      const rehydrateIndex = writes.findIndex((data) => data.includes('\x1b[?1002h'))
      const resetIndex = writes.indexOf(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE)
      const tailIndex = writes.lastIndexOf('\x1b[3')
      expect(clearIndex).toBeGreaterThanOrEqual(0)
      expect(bodyIndex).toBeGreaterThan(clearIndex)
      expect(rehydrateIndex).toBeGreaterThan(bodyIndex)
      expect(resetIndex).toBeGreaterThan(rehydrateIndex)
      // The dangling escape tail stays LAST so the next live chunk completes it (#7329).
      expect(tailIndex).toBeGreaterThan(resetIndex)
      expect(writes.slice(tailIndex + 1).filter((data) => data !== '')).toEqual([])
    })

    it('suppresses the redundant alt-screen transition when the buffer is already alternate', async () => {
      const { pane, writes, replayCallback } = await connectPushReplayPane()
      // Why: xterm swaps its per-screen kitty flag slots on EVERY 1049h, so a
      // redundant transition would clobber the flags the application negotiated.
      ;(pane.terminal.buffer.active as { type: string }).type = 'alternate'

      replayCallback.current?.('pushed replay tail', { modes: REPLAY_RESTORE_MODES })
      await flushAsyncTicks(30)

      expect(writes.some((data) => data.includes('\x1b[?1049h'))).toBe(false)
      const rehydrateIndex = writes.findIndex((data) => data.includes('\x1b[?1002h'))
      expect(rehydrateIndex).toBeGreaterThan(writes.indexOf('pushed replay tail'))
      expect(writes).toContain(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE)
    })
  })
})
