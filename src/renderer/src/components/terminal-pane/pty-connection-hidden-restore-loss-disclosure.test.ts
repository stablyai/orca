import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_AFTER_BYTE_GAP } from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// STA-4869 — routes R1 (host retry budget), R2 (permanently-unavailable) and R5
// (local deferred-retry exhaustion) all end in the NON-QUIET abandon at
// pty-connection.ts:7106, whose only loss disclosure is
// writeRestoreUnavailableWarning (7302). That function early-returns the banner
// when the pane is not foreground, and the abandon has already zeroed
// hiddenOutputRestoreNeeded/PtyId and cleared the flood repaint timer.
//
// Invariant asserted here: when renderer delivery was withheld while hidden,
// reveal must either reconcile every retained byte exactly once or leave a
// durable loss banner on the pane. Never neither.

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

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))

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

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const REMOTE_PTY_ID = 'remote:env-1@@terminal-sta4869'
const LOCAL_PTY_ID = 'pty-id'
// Overruns the renderer's 2MB hidden background queue: the bytes exist only in
// the authority's buffer afterwards, which is what reveal has to reconcile.
const HIDDEN_FLOOD = 'x'.repeat(2 * 1024 * 1024 + 1)
const LIVE_CHUNK = 'live-after-reveal\r\n'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const R1_MARKER = 'R1-LOST-7f3a'
const R2_MARKER = 'R2-LOST-91c4'
const R5_MARKER = 'R5-LOST-b28e'

type RetainedSnapshot = {
  data: string
  cols: number
  rows: number
  seq: number
}

/** The authority's retained content — the only carrier of the dropped bytes. */
function retainedSnapshot(marker: string): RetainedSnapshot {
  return {
    data: `${marker}\r\n`,
    cols: 120,
    rows: 40,
    seq: HIDDEN_FLOOD.length + LIVE_CHUNK.length
  }
}

function hostAnswers(snapshot: RetainedSnapshot): unknown {
  return { availability: { kind: 'snapshot' }, snapshot }
}

type PaneDrive = {
  pane: MockPane
  deps: PaneConnectionDeps
  disposable: { dispose: () => void }
  deliver: (data: string, seq: number) => void
  setVisible: (visible: boolean) => void
  writtenChunks: () => string[]
}

async function connectHiddenPane(
  ptyId: string,
  configureTransport: (transport: MockTransport) => void
): Promise<PaneDrive> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(ptyId)
  configureTransport(transport)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return ptyId
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: false }
  })
  const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    deps,
    disposable,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (visible) => {
      ;(deps.isVisibleRef as { current: boolean }).current = visible
    },
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

/** Hidden-time bytes are dropped, then the pane is revealed with live output
 *  still streaming — the reveal path the gate's recovery loop owns. */
function floodWhileHiddenThenReveal(drive: PaneDrive): void {
  drive.deliver(HIDDEN_FLOOD, HIDDEN_FLOOD.length)
  drive.setVisible(true)
  drive.deliver(LIVE_CHUNK, HIDDEN_FLOOD.length + LIVE_CHUNK.length)
}

async function revealPane(drive: PaneDrive): Promise<void> {
  drive.setVisible(true)
  const { requestTerminalBacklogRecovery } =
    await import('@/lib/pane-manager/pane-terminal-output-scheduler')
  requestTerminalBacklogRecovery(drive.pane.terminal as never)
  await flushAsyncTicks(20)
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

type Disclosure = {
  bannerWrites: number
  markerWrites: number
  disclosedOrRecovered: boolean
}

function observeDisclosure(drive: PaneDrive, marker: string): Disclosure {
  const written = drive.writtenChunks()
  const bannerWrites = written.filter((data) => data.includes(BANNER_FRAGMENT)).length
  const markerWrites = countOccurrences(written.join(''), marker)
  return {
    bannerWrites,
    markerWrites,
    disclosedOrRecovered: bannerWrites > 0 || markerWrites === 1
  }
}

function expectDisclosedOrRecovered(disclosure: Disclosure): void {
  expect(
    disclosure.disclosedOrRecovered,
    `hidden output was neither reconciled nor disclosed: ${JSON.stringify(disclosure)}`
  ).toBe(true)
}

/** Long enough for every deferred repaint, re-arm cycle and retry tick. */
async function allowRecoveryWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000)
  await flushAsyncTicks(20)
}

describe('hidden-output restore loss disclosure (STA-4869)', () => {
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

  // ── R1: host retry-worthy budget (7 answers) ────────────────────────────
  describe('R1 host retry budget exhaustion', () => {
    const retryWorthy = {
      availability: { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' },
      snapshot: null
    }

    async function driveToSeventhAnswer(
      serializeBufferOutcome: ReturnType<typeof vi.fn>
    ): Promise<PaneDrive> {
      const drive = await connectHiddenPane(REMOTE_PTY_ID, (transport) => {
        transport.serializeBuffer = vi.fn()
        transport.serializeBufferOutcome = serializeBufferOutcome
      })
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
      // Each retry-worthy answer quietly re-arms one post-suppression repaint.
      for (let request = 2; request <= 6; request += 1) {
        await vi.advanceTimersByTimeAsync(2_000)
        await flushAsyncTicks(20)
        expect(serializeBufferOutcome).toHaveBeenCalledTimes(request)
      }
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      return drive
    }

    it('[control] discloses the loss when the budget ends while the pane is visible', async () => {
      const serializeBufferOutcome = vi.fn().mockResolvedValue(retryWorthy)
      const drive = await driveToSeventhAnswer(serializeBufferOutcome)

      await vi.advanceTimersByTimeAsync(2_000)
      await flushAsyncTicks(20)
      serializeBufferOutcome.mockResolvedValue(hostAnswers(retainedSnapshot(R1_MARKER)))
      await allowRecoveryWindow()

      expect(observeDisclosure(drive, R1_MARKER)).toMatchObject({ disclosedOrRecovered: true })
      drive.disposable.dispose()
    })

    it('[invariant] discloses or recovers when the budget ends while the pane is hidden', async () => {
      const seventhAnswer = createDeferred<unknown>()
      const serializeBufferOutcome = vi.fn().mockResolvedValue(retryWorthy)
      const drive = await driveToSeventhAnswer(serializeBufferOutcome)

      serializeBufferOutcome.mockReturnValueOnce(seventhAnswer.promise)
      await vi.advanceTimersByTimeAsync(2_000)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(7)

      // The user switches tabs while the seventh request is still outstanding;
      // the restore loop keeps running across the await.
      drive.setVisible(false)
      seventhAnswer.resolve(retryWorthy)
      await flushAsyncTicks(20)

      // The host is healthy again and still holds the dropped bytes.
      serializeBufferOutcome.mockResolvedValue(hostAnswers(retainedSnapshot(R1_MARKER)))
      const requestsBeforeReveal = serializeBufferOutcome.mock.calls.length
      await revealPane(drive)
      await allowRecoveryWindow()

      const disclosure = observeDisclosure(drive, R1_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      // Whichever way the gap is closed, silence is not one of them: recovering
      // it costs a fresh request, disclosing it costs a banner.
      expect(
        serializeBufferOutcome.mock.calls.length - requestsBeforeReveal
      ).toBeGreaterThanOrEqual(disclosure.bannerWrites > 0 ? 0 : 1)
      drive.disposable.dispose()
    })

    async function exhaustBudgetWhileHidden(
      serializeBufferOutcome: ReturnType<typeof vi.fn>
    ): Promise<PaneDrive> {
      const seventhAnswer = createDeferred<unknown>()
      const drive = await driveToSeventhAnswer(serializeBufferOutcome)
      serializeBufferOutcome.mockReturnValueOnce(seventhAnswer.promise)
      await vi.advanceTimersByTimeAsync(2_000)
      await flushAsyncTicks(20)
      drive.setVisible(false)
      seventhAnswer.resolve(retryWorthy)
      await flushAsyncTicks(20)
      return drive
    }

    it('[fix] heals exactly once on one fresh snapshot when the host recovered', async () => {
      const serializeBufferOutcome = vi.fn().mockResolvedValue(retryWorthy)
      const drive = await exhaustBudgetWhileHidden(serializeBufferOutcome)

      serializeBufferOutcome.mockResolvedValue(hostAnswers(retainedSnapshot(R1_MARKER)))
      const requestsBeforeReveal = serializeBufferOutcome.mock.calls.length
      await revealPane(drive)
      await allowRecoveryWindow()

      expect(observeDisclosure(drive, R1_MARKER)).toMatchObject({
        bannerWrites: 0,
        markerWrites: 1
      })
      // Reveal is the bounded retry: one fresh snapshot, not a fresh budget.
      expect(serializeBufferOutcome.mock.calls.length - requestsBeforeReveal).toBe(1)
      drive.disposable.dispose()
    })

    it('[fix] banners once when the host is still broken at reveal', async () => {
      const serializeBufferOutcome = vi.fn().mockResolvedValue(retryWorthy)
      const drive = await exhaustBudgetWhileHidden(serializeBufferOutcome)
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)

      const requestsBeforeReveal = serializeBufferOutcome.mock.calls.length
      await revealPane(drive)
      await allowRecoveryWindow()

      // The spent budget abandons on the first foreground answer, so the
      // disclosure now lands where it can be read.
      expect(observeDisclosure(drive, R1_MARKER)).toMatchObject({
        bannerWrites: 1,
        markerWrites: 0
      })
      // Reveal is a bounded retry, not a fresh budget: one host request, then
      // the banner. Carrying the spent counters across the deferral is what
      // makes this hold — a reset would re-run all seven against a dead host.
      expect(serializeBufferOutcome.mock.calls.length - requestsBeforeReveal).toBe(1)
      drive.disposable.dispose()
    })
  })

  // ── R2: permanently-unavailable ─────────────────────────────────────────
  describe('R2 permanently-unavailable answer', () => {
    const permanentlyUnavailable = {
      availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
      snapshot: null
    }

    it('[control] banners once when the answer lands while the pane is visible', async () => {
      const serializeBufferOutcome = vi.fn().mockResolvedValue(permanentlyUnavailable)
      const drive = await connectHiddenPane(REMOTE_PTY_ID, (transport) => {
        transport.serializeBuffer = vi.fn()
        transport.serializeBufferOutcome = serializeBufferOutcome
      })
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)
      await allowRecoveryWindow()

      expect(observeDisclosure(drive, R2_MARKER)).toMatchObject({
        bannerWrites: 1,
        disclosedOrRecovered: true
      })
      drive.disposable.dispose()
    })

    it('[invariant] discloses or recovers when the answer lands while the pane is hidden', async () => {
      const answer = createDeferred<unknown>()
      const serializeBufferOutcome = vi.fn().mockReturnValue(answer.promise)
      const drive = await connectHiddenPane(REMOTE_PTY_ID, (transport) => {
        transport.serializeBuffer = vi.fn()
        transport.serializeBufferOutcome = serializeBufferOutcome
      })
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)

      drive.setVisible(false)
      answer.resolve(permanentlyUnavailable)
      await flushAsyncTicks(20)

      serializeBufferOutcome.mockResolvedValue(hostAnswers(retainedSnapshot(R2_MARKER)))
      await revealPane(drive)
      await allowRecoveryWindow()

      const disclosure = observeDisclosure(drive, R2_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })

  // ── R5: local snapshot unavailable, deferred retries exhausted ──────────
  describe('R5 local deferred-retry exhaustion', () => {
    async function connectLocalHiddenPane(): Promise<PaneDrive> {
      // A codex startup makes the renderer skip hidden bytes locally, which is
      // the local mirror of the remote pause the other routes model.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport(LOCAL_PTY_ID)
      const captured: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
          captured.current = callbacks?.onData ?? null
          return LOCAL_PTY_ID
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const deps = buildPaneConnectionDeps(() => mockStoreState, {
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(6)
      expect(captured.current).not.toBeNull()
      return {
        pane,
        deps,
        disposable,
        deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
        setVisible: (visible) => {
          ;(deps.isVisibleRef as { current: boolean }).current = visible
        },
        writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
      }
    }

    it('[control] banners once when the retries run out while the pane is visible', async () => {
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      getMainBufferSnapshot.mockResolvedValue(null)
      const drive = await connectLocalHiddenPane()
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(50)
        await flushAsyncTicks(20)
      }

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(4)
      expect(observeDisclosure(drive, R5_MARKER)).toMatchObject({
        bannerWrites: 1,
        disclosedOrRecovered: true
      })
      drive.disposable.dispose()
    })

    it('[invariant] keeps recovery armed when the pane hides before the retries run out', async () => {
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      getMainBufferSnapshot.mockResolvedValue(null)
      const drive = await connectLocalHiddenPane()
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)

      // The pane goes background one retry into the budget.
      await vi.advanceTimersByTimeAsync(50)
      await flushAsyncTicks(20)
      drive.setVisible(false)
      await allowRecoveryWindow()

      // Main still holds the dropped bytes; reveal must spend them.
      getMainBufferSnapshot.mockResolvedValue(retainedSnapshot(R5_MARKER))
      await revealPane(drive)
      await allowRecoveryWindow()

      const disclosure = observeDisclosure(drive, R5_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })

  // ── The restore loop's PTY-swap arm (pty-connection.ts ~7660) ────────────
  // The one writeRestoreUnavailableWarning caller the defer guard does not
  // cover. It is reachable only from loop iteration 2+, which the hidden-pause
  // guard after the replay makes foreground-only, and it is remote-only (a
  // local ptyId always satisfies canUseHiddenOutputSnapshot) — so the re-arm
  // budget clearHiddenOutputRestoreState() just reset always wins and the
  // banner call is dead. Entering it with the budget already spent is not
  // constructible: iteration 2 requires a successful snapshot first, and that
  // zeroes hiddenOutputRestoreRemoteAbandonCycles on the way through.
  describe('restore-loop PTY-swap arm', () => {
    it('[fix] re-arms instead of declaring a loss when the host loses snapshot capability', async () => {
      const swapMarker = 'R7-LOST-3e91'
      const answer = createDeferred<unknown>()
      const serializeBufferOutcome = vi.fn().mockReturnValue(answer.promise)
      let paneTransport: MockTransport | null = null
      const drive = await connectHiddenPane(REMOTE_PTY_ID, (transport) => {
        paneTransport = transport
        transport.serializeBuffer = vi.fn()
        transport.serializeBufferOutcome = serializeBufferOutcome
      })
      const transport = paneTransport as unknown as MockTransport
      const { resetTerminalFreezeBreadcrumbsForTesting, getTerminalFreezeBreadcrumbs } =
        await import('./terminal-freeze-breadcrumbs')
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)

      // A chunk landing while the pane is momentarily background marks the
      // in-flight snapshot stale, which is what sends the loop around again.
      drive.setVisible(false)
      drive.deliver('stale-during-restore\r\n', HIDDEN_FLOOD.length + LIVE_CHUNK.length + 32)
      drive.setVisible(true)

      // The host drops snapshot support underneath the in-flight request.
      transport.serializeBuffer = undefined
      resetTerminalFreezeBreadcrumbsForTesting()
      answer.resolve(hostAnswers(retainedSnapshot(swapMarker)))
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, swapMarker)
      expect(disclosure.bannerWrites).toBe(0)
      // Route proof: the re-arm reason names this arm, not the deadline abandon.
      expect(
        getTerminalFreezeBreadcrumbs()
          .filter((crumb) => crumb.kind === 'restore-abandon-rearm')
          .map((crumb) => crumb.detail?.reason)
      ).toEqual(['restore-pty-swapped'])
      // The gap is still grounded, and the deferred repaint keeps recovery armed.
      expect(drive.writtenChunks()).toContain(RESET_AFTER_BYTE_GAP)
      drive.disposable.dispose()
    })
  })
})
