import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type MockPane,
  type MockPaneManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

/**
 * End to end through connectPanePty: a parked remote-runtime pane is revealed,
 * the host answers its snapshot probe with `unavailable: 'no-serializable-buffer'`
 * ("not proof the pane is empty", per the host's own comment), and the pane must
 * keep asking on the hidden-output restore loop's budget rather than paint blank
 * once and go quiet. The request count and the loss banner are the oracle: with
 * the reveal collapsing the answer to null, the count stays at one forever and
 * the banner never appears.
 */
const REMOTE_PTY_ID = 'remote:env-1@@pty-1'
const HOST_IMAGE_MARKER = 'HOST-IMAGE-AFTER-PARK'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const STRUCTURAL_CLEAR = '\x1b[2J\x1b[3J'

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

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

function nextQueuedTransport(): MockTransport {
  const nextTransport = transportFactoryQueue.shift()
  if (!nextTransport) {
    throw new Error('No mock transport queued')
  }
  return nextTransport
}

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => nextQueuedTransport())
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => nextQueuedTransport())
}))

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

/** The host advertised paired parking while it was reachable, so the reveal reattaches its pty. */
function pairedParkingHostStatus(): StoreState['runtimeStatusByEnvironmentId'] {
  return new Map([
    [
      'env-1',
      { checkedAt: 1, status: { capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY] } }
    ]
  ])
}

type ConnectMockPane = (
  pane: MockPane,
  manager: MockPaneManager,
  deps: PaneConnectionDeps
) => { dispose: () => void }

async function revealParkedRemotePane(
  serializeBufferOutcome: ReturnType<typeof vi.fn>
): Promise<{ transport: MockTransport; writes: string[]; dispose: () => void }> {
  const { connectPanePty } = await import('./pty-connection')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock pane, manager, and deps stand in for the real xterm-backed objects, exactly as every other connectPanePty suite drives them.
  const connectMockPane = connectPanePty as unknown as ConnectMockPane
  const transport = createMockTransport()
  // The remote transport's park-reveal result: a bare reattach with no relay tail.
  transport.connect.mockImplementation(async () => {
    transport.getPtyId.mockReturnValue(REMOTE_PTY_ID)
    return { id: REMOTE_PTY_ID, replay: '', isReattach: true }
  })
  transport.serializeBuffer = vi.fn()
  transport.serializeBufferOutcome = serializeBufferOutcome
  transportFactoryQueue.push(transport)
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: REMOTE_PTY_ID }] },
    ptyIdsByTabId: { 'tab-1': [REMOTE_PTY_ID] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: REMOTE_PTY_ID }
      }
    },
    runtimeStatusByEnvironmentId: pairedParkingHostStatus()
  }
  const pane = createPane(1)
  const { writes } = captureCallbackTerminalWrites(pane)
  // Why the active pane: an inactive split defers its restore to the frame scheduler.
  const binding = connectMockPane(
    pane,
    createManager(1, 1),
    createDeps({
      mountFollowsTerminalPark: true,
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: REMOTE_PTY_ID }
    })
  )
  await flushAsyncTicks(30)
  expect(transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: REMOTE_PTY_ID })
  )
  return { transport, writes, dispose: () => binding.dispose() }
}

function bannerCount(writes: string[]): number {
  return writes.filter((data) => data.includes(BANNER_FRAGMENT)).length
}

describe('parked remote pane reveal with an unverifiable host snapshot', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await restoreTerminalTestGlobals()
  })

  it("keeps asking a host that answered 'no-serializable-buffer' and banners once the budget is spent", async () => {
    const declined = {
      availability: { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' },
      snapshot: null
    }
    // Why the deferred second answer: the loop arms its 2s re-ask timer when an
    // answer lands, and that timer must be created under fake timers to advance.
    const secondAnswer = createDeferred<typeof declined>()
    const serializeBufferOutcome = vi
      .fn()
      .mockResolvedValueOnce(declined)
      .mockReturnValueOnce(secondAnswer.promise)
      .mockResolvedValue(declined)
    const reveal = await revealParkedRemotePane(serializeBufferOutcome)

    // The reveal's own probe, plus the immediate re-ask it hands to the restore loop.
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(2)
    expect(reveal.writes.join('')).not.toContain(STRUCTURAL_CLEAR)
    expect(bannerCount(reveal.writes)).toBe(0)

    vi.useFakeTimers()
    secondAnswer.resolve(declined)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(2)
    // One shared budget: the reveal probe counts, so five more 2s cycles reach the seventh.
    for (let expectedRequests = 3; expectedRequests <= 7; expectedRequests += 1) {
      await vi.advanceTimersByTimeAsync(2_000)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(expectedRequests)
      expect(bannerCount(reveal.writes)).toBe(expectedRequests === 7 ? 1 : 0)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(7)
    expect(bannerCount(reveal.writes)).toBe(1)
    // At no point did the pane claim to be empty.
    expect(reveal.writes.join('')).not.toContain(STRUCTURAL_CLEAR)
    reveal.dispose()
  })

  it('paints the host image when the host answers with one, and asks nothing more', async () => {
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: { data: `${HOST_IMAGE_MARKER}\r\n`, cols: 80, rows: 24, seq: 3, source: 'headless' }
    })
    const reveal = await revealParkedRemotePane(serializeBufferOutcome)

    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    const painted = reveal.writes.join('')
    expect(painted).toContain(STRUCTURAL_CLEAR)
    expect(painted).toContain(HOST_IMAGE_MARKER)

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(bannerCount(reveal.writes)).toBe(0)
    reveal.dispose()
  })
})
