import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_REATTACH_RESET,
  PROCESS_BOUNDARY_GROUND
} from '../../../../shared/terminal-mode-reset-profiles'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { replayEpilogue } from './pty-connection-test-replay-epilogue'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
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

// Why: xterm and the pane mirror must end every restore on the same kitty flags.
describe('connectPanePty kitty keyboard restore', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function reattachWithSnapshotFlags(kittyKeyboard: boolean) {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'live app frame',
            snapshotKittyKeyboardFlags: 31,
            snapshotSeq: 7
          }
        : null
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.options.vtExtensions.kittyKeyboard = kittyKeyboard
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane-connection mocks cover the members connectPanePty reads.
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    return { pane, mirror: deps.paneKittyKeyboardModesRef.current.get(pane.id) }
  }

  it("restores a live app's host-proven flags into xterm and the mirror on reattach", async () => {
    const { pane, mirror } = await reattachWithSnapshotFlags(true)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${POST_REPLAY_REATTACH_RESET}\x1b[<99u\x1b[=31u`,
      expect.any(Function)
    )
    expect(mirror?.flags).toBe(31)
  })

  // Why: xterm ignores CSI u while the protocol is withheld (ConPTY), so its mirror must too.
  it('keeps a withheld-protocol pane at 0 in both records despite host flags', async () => {
    const { pane, mirror } = await reattachWithSnapshotFlags(false)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      replayEpilogue(POST_REPLAY_REATTACH_RESET),
      expect.any(Function)
    )
    expect(mirror?.flags).toBe(0)
  })

  it('grounds xterm and the mirror with one scanned write before a restart-in-place spawns', async () => {
    const { connectPanePty } = await import('./pty-connection')
    transportFactoryQueue.push(createMockTransport())
    const pane = createPane(91)
    // Why: a unique tab id keeps this pane's key clear of other tests' pendingSpawnByPaneKey entries so the connect deterministically fresh-spawns.
    const deps = createDeps({ tabId: 'tab-kitty-fresh-spawn' })
    // The pane's previous occupant left the alternate screen and kitty flags on.
    const mirror = new TerminalKittyKeyboardModeTracker()
    mirror.scan('\x1b[?1049h\x1b[>5u')
    deps.paneKittyKeyboardModesRef.current.set(pane.id, mirror)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane-connection mocks cover the members connectPanePty reads.
    connectPanePty(pane as never, createManager(91) as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(PROCESS_BOUNDARY_GROUND, expect.any(Function))
    expect(mirror.snapshotFlags).toBe(0)
    expect(mirror.isAlternateScreen).toBe(false)
  })

  it('grounds xterm and the mirror together on Reset Terminal and asks the host to ground', async () => {
    const { pane, mirror } = await reattachWithSnapshotFlags(true)
    expect(mirror?.flags).toBe(31)
    const { resetTerminalInputModes } = await import('./terminal-input-mode-reset')

    resetTerminalInputModes('tab-pty')

    expect(pane.terminal.write).toHaveBeenLastCalledWith(
      PROCESS_BOUNDARY_GROUND,
      expect.any(Function)
    )
    expect(mirror?.flags).toBe(0)
    expect(window.api.pty.resetInputModes).toHaveBeenCalledWith('tab-pty')
  })
})
