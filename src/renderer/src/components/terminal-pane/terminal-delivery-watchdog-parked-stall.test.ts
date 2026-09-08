/**
 * The per-PTY lane, end to end: dispatcher parks bytes → watchdog tick → remount or write-off.
 *
 * The mask this closes is arithmetic. On a machine with a hundred terminals, "any pty:data
 * event since the last tick" and session-global `msSinceLastAck` read healthy essentially
 * always, so the tick used to return before ever asking main — and one pane wedged with no
 * data handler stayed invisible while its shell kept flooding it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const storeState = {
  ptyIdsByTabId: {} as Record<string, string[]>,
  getTab: vi.fn((tabId: string) => ({ id: tabId })),
  remountTerminalTabForRecovery: vi.fn(() => true)
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

const INTERVAL_MS = 15_000
const WEDGED_PTY_ID = 'pty-wedged'
const LIVE_PTY_ID = 'pty-live'
const WEDGED_TAB_ID = 'tab-wedged'
const WEDGED_OUTPUT = 'output nobody renders'

/** Parked output has already returned all producer credit. */
const BUSY_MAIN: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: 0,
  inFlightPtyCount: 0,
  msSinceLastAck: 200
}

type PtyDataPayload = { id: string; data: string }

describe('per-PTY parked delivery stall', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const reportMock = vi.fn<(args: unknown) => Promise<PtyRendererDeliveryHealthReply | null>>()
  const reattachMock = vi.fn()
  let emitPtyData: (payload: PtyDataPayload) => void
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    reportMock.mockReset()
    reattachMock.mockClear()
    storeState.ptyIdsByTabId = {}
    storeState.remountTerminalTabForRecovery.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          onData: (listener: (payload: PtyDataPayload) => void) => {
            emitPtyData = listener
            return () => {}
          },
          onReplay: () => () => {},
          onExit: () => () => {},
          ackData: vi.fn(),
          hasPty: vi.fn(async () => true),
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: () => 1
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  /** Arms the watchdog with assertable deps first; the dispatcher's own start then no-ops. */
  async function startDispatcherAndWatchdog(): Promise<{
    parkedCharsByPty: () => Record<string, number>
    streamLiveOutput: () => void
  }> {
    const watchdog = await import('./terminal-delivery-watchdog')
    const { recoverParkedPanes } = await import('./terminal-parked-pane-recovery')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true,
      // The real ownership resolver over the mocked store, so the remount path is not stubbed.
      recoverParkedPanes: async (ptyIds) => recoverParkedPanes(ptyIds)
    })
    const dispatcher = await import('./pty-dispatcher')
    dispatcher.ptyDataHandlers.set(LIVE_PTY_ID, () => {})
    dispatcher.ensurePtyDispatcher()
    const { getParkedPreHandlerCharsByPty } = await import('./pty-pre-handler-buffer')
    return {
      parkedCharsByPty: getParkedPreHandlerCharsByPty,
      streamLiveOutput: () => emitPtyData({ id: LIVE_PTY_ID, data: 'still streaming' })
    }
  }

  function healCalls(): unknown[] {
    return reportMock.mock.calls
      .map((call) => call[0])
      .filter((args) => (args as { heal?: boolean }).heal === true)
  }

  it('remounts the owning tab of a pane parked across two ticks while other panes stream', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(BUSY_MAIN)
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()

    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    expect(parkedCharsByPty()).toEqual({ [WEDGED_PTY_ID]: WEDGED_OUTPUT.length })

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(reportMock.mock.calls[0]![0]).not.toHaveProperty('parkedCharsByPty')

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // Local occupancy drives recovery even with zero main debt.
    expect(storeState.remountTerminalTabForRecovery).toHaveBeenCalledWith(WEDGED_TAB_ID)
    expect(reattachMock).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(0)
  })

  it('keeps unowned output bounded without requesting a credit write-off', async () => {
    reportMock.mockResolvedValue(BUSY_MAIN)
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()
    emitPtyData({ id: WEDGED_PTY_ID, data: 'x'.repeat(512 * 1024) })
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    emitPtyData({ id: WEDGED_PTY_ID, data: 'tail' })
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(parkedCharsByPty()).toEqual({ [WEDGED_PTY_ID]: 4 })
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(0)
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('recovers local occupancy even when the main health reply is unavailable', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(null)
    await startDispatcherAndWatchdog()
    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(storeState.remountTerminalTabForRecovery).toHaveBeenCalledWith(WEDGED_TAB_ID)
  })

  it('does not mistake byte-cap eviction for consumer progress', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(BUSY_MAIN)
    await startDispatcherAndWatchdog()
    emitPtyData({ id: WEDGED_PTY_ID, data: 'x'.repeat(512 * 1024) })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    emitPtyData({ id: WEDGED_PTY_ID, data: 'tail' })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(storeState.remountTerminalTabForRecovery).toHaveBeenCalledWith(WEDGED_TAB_ID)
  })

  it('heals an unreceived PTY while siblings stream and nothing is parked', async () => {
    reportMock.mockResolvedValue({
      ...BUSY_MAIN,
      inFlightTotalChars: 100,
      inFlightPtyCount: 1,
      stalledPtys: [{ id: WEDGED_PTY_ID, inFlightChars: 100, msSinceLastAck: null }]
    })
    const { streamLiveOutput } = await startDispatcherAndWatchdog()
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(healCalls()).toHaveLength(1)
    expect(reattachMock).not.toHaveBeenCalled()
    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('leaves the ordinary pre-attach race alone: parked bytes that drain never heal', async () => {
    storeState.ptyIdsByTabId = { [WEDGED_TAB_ID]: [WEDGED_PTY_ID] }
    reportMock.mockResolvedValue(BUSY_MAIN)
    const { parkedCharsByPty, streamLiveOutput } = await startDispatcherAndWatchdog()
    const dispatcher = await import('./pty-dispatcher')

    emitPtyData({ id: WEDGED_PTY_ID, data: WEDGED_OUTPUT })
    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // The pane binds, which is what the buffer exists for.
    dispatcher.registerEagerPtyBuffer(WEDGED_PTY_ID, () => {})
    expect(parkedCharsByPty()).toEqual({})

    streamLiveOutput()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    expect(storeState.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(healCalls()).toHaveLength(0)
  })
})
