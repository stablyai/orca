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
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'

// STA-4869: exhausted/permanent restore failures must reconcile retained bytes or disclose loss on reveal, even if abandonment occurred while backgrounded.

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

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

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
// Overflow the 2MB client queue so reveal must reconcile bytes retained only by the authority.
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
  setOutputPaused: (paused: boolean, dropsReported?: boolean) => void
  reportPausedOutputDropped: () => void
  writtenChunks: () => string[]
}

async function connectHiddenPane(
  ptyId: string,
  configureTransport: (transport: MockTransport) => void
): Promise<PaneDrive> {
  const transport = createMockTransport(ptyId)
  configureTransport(transport)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  const capturedPause: {
    current: ((paused: boolean, supported: boolean, dropsReported?: boolean) => void) | null
  } = {
    current: null
  }
  const capturedDropped: { current: (() => void) | null } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    capturedPause.current = callbacks?.onOutputPauseChanged ?? null
    capturedDropped.current = callbacks?.onPausedOutputDropped ?? null
    return ptyId
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: false }
  })
  const disposable = await connectMockPanePty(pane, createManager(1), deps)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    deps,
    disposable,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (visible) => {
      deps.isVisibleRef.current = visible
    },
    setOutputPaused: (paused, dropsReported) =>
      capturedPause.current?.(paused, true, dropsReported),
    reportPausedOutputDropped: () => capturedDropped.current?.(),
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
  requestTerminalBacklogRecovery(drive.pane.terminal)
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

  describe('R1 host retry budget exhaustion', () => {
    const retryWorthy = {
      availability: {
        kind: 'retry-worthy',
        cause: 'host-pending-output-overflowed'
      },
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

      expect(observeDisclosure(drive, R1_MARKER)).toMatchObject({
        disclosedOrRecovered: true
      })
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

      // Switch away while the last budgeted request is still pending.
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
      // Require either a fresh recovery request or a visible loss banner.
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

      // Spent-budget abandonment must defer disclosure until foreground reveal.
      expect(observeDisclosure(drive, R1_MARKER)).toMatchObject({
        bannerWrites: 1,
        markerWrites: 0
      })
      // Preserve spent counters across deferral: reveal gets one host request, not another seven-attempt budget.
      expect(serializeBufferOutcome.mock.calls.length - requestsBeforeReveal).toBe(1)
      drive.disposable.dispose()
    })
  })

  describe('R2 permanently-unavailable answer', () => {
    const permanentlyUnavailable = {
      availability: {
        kind: 'permanently-unavailable',
        reason: 'exceeds-client-replay-limit'
      },
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

  // SSH and paired panes reveal through host unpause, requiring separate coverage from local backlog recovery.
  describe('remote output-pause reveal', () => {
    const REMOTE_MARKER = 'REMOTE-LOST-4d19'
    const answersWhileHidden = [
      {
        host: 'modern host, permanently unavailable',
        failure: {
          availability: {
            kind: 'permanently-unavailable',
            reason: 'exceeds-client-replay-limit'
          },
          snapshot: null
        },
        legacy: false,
        dropsReported: false
      },
      {
        // #29253: the host reports drops, so only its drop frame arms the restore.
        host: 'drop-reporting host, permanently unavailable',
        failure: {
          availability: {
            kind: 'permanently-unavailable',
            reason: 'exceeds-client-replay-limit'
          },
          snapshot: null
        },
        legacy: false,
        dropsReported: true
      },
      { host: 'legacy host, no snapshot yet', failure: null, legacy: true, dropsReported: false }
    ]
    it.each(answersWhileHidden)(
      '[invariant] restores on the unpause reveal after a restore failed while hidden ($host)',
      async ({ failure, legacy, dropsReported }) => {
        const answer = createDeferred<unknown>()
        const request = vi.fn().mockReturnValue(answer.promise)
        const drive = await connectHiddenPane(REMOTE_PTY_ID, (transport) => {
          transport.serializeBuffer = legacy ? request : vi.fn()
          transport.serializeBufferOutcome = legacy ? undefined : request
        })
        vi.useFakeTimers()
        drive.setOutputPaused(true, dropsReported)
        if (dropsReported) {
          drive.reportPausedOutputDropped()
        }
        drive.setVisible(true)
        drive.setOutputPaused(false, dropsReported)
        await flushAsyncTicks(20)
        expect(request).toHaveBeenCalledTimes(1)

        // Switch away before the answer; hosts do not resend reported drops, so the pending restore must survive.
        drive.setVisible(false)
        drive.setOutputPaused(true, dropsReported)
        answer.resolve(failure)
        await flushAsyncTicks(20)
        await allowRecoveryWindow()

        const snapshot = retainedSnapshot(REMOTE_MARKER)
        request.mockResolvedValue(legacy ? snapshot : hostAnswers(snapshot))
        drive.setVisible(true)
        drive.setOutputPaused(false, dropsReported)
        await flushAsyncTicks(20)

        expect(request).toHaveBeenCalledTimes(2)
        expect(observeDisclosure(drive, REMOTE_MARKER)).toMatchObject({
          bannerWrites: 0,
          markerWrites: 1
        })
        drive.disposable.dispose()
      }
    )
  })

  describe('R5 local deferred-retry exhaustion', () => {
    async function connectLocalHiddenPane(): Promise<PaneDrive> {
      // Gate local hidden output to mirror the host pause exercised by remote routes.
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
      const disposable = await connectMockPanePty(pane, createManager(1), deps)
      await flushAsyncTicks(6)
      expect(captured.current).not.toBeNull()
      return {
        pane,
        deps,
        disposable,
        deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
        setVisible: (visible) => {
          deps.isVisibleRef.current = visible
        },
        // Local panes are gated in main, not paused on a host.
        setOutputPaused: () => {},
        reportPausedOutputDropped: () => {},
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

  // The PTY-swap arm requires a prior successful snapshot, which resets its abandon budget; a deferred repaint must keep any subsequent gap recoverable.
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
      if (!paneTransport) {
        throw new Error('transport was never configured')
      }
      const transport: MockTransport = paneTransport
      const { resetTerminalFreezeBreadcrumbsForTesting, getTerminalFreezeBreadcrumbs } =
        await import('./terminal-freeze-breadcrumbs')
      vi.useFakeTimers()
      floodWhileHiddenThenReveal(drive)
      await flushAsyncTicks(20)
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)

      // A background chunk stales the in-flight snapshot and forces a second iteration.
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
      expect(drive.writtenChunks().some((chunk) => chunk.startsWith(RESET_AFTER_BYTE_GAP))).toBe(
        true
      )
      drive.disposable.dispose()
    })
  })
})
