// Why: pins the renderer half of the dead-push-delivery recovery — the
// watchdog must cost nothing while output flows, confirm a wedge across two
// silent ticks against main's invoke-reported state, then heal exactly once
// per cooldown: re-attach push listeners, request the write-off, and route
// the pulled restore markers to pane handlers locally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

const INTERVAL_MS = 15_000

const HEALTHY: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: 0,
  inFlightPtyCount: 0,
  msSinceLastAck: 1_000
}

const STALLED: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: 512 * 1024,
  inFlightPtyCount: 2,
  msSinceLastAck: null
}

describe('terminal delivery watchdog', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const reportMock = vi.fn<(args: unknown) => Promise<PtyRendererDeliveryHealthReply>>()
  const listenerCountMock = vi.fn(() => 1)
  const reattachMock = vi.fn()
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    reportMock.mockReset()
    listenerCountMock.mockClear()
    reattachMock.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: listenerCountMock
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

  async function startWatchdog(): Promise<{
    recordPtyDataReceived: (ptyId: string, chars: number) => void
    registerRestoreHandler: (
      ptyId: string,
      handler: (event: { id: string; reason: string; markerSeq?: number }) => void
    ) => void
  }> {
    const watchdog = await import('./terminal-delivery-watchdog')
    const restoreChannel = await import('./pty-model-restore-channel')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true
    })
    return {
      recordPtyDataReceived: watchdog.recordPtyDataReceived,
      registerRestoreHandler: (ptyId, handler) => {
        restoreChannel.registerPtyModelRestoreNeededHandler(ptyId, handler)
      }
    }
  }

  it('does zero IPC while pty output is flowing', async () => {
    const { recordPtyDataReceived } = await startWatchdog()

    for (let tick = 0; tick < 8; tick++) {
      recordPtyDataReceived('pty-1', 64)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }

    expect(reportMock).not.toHaveBeenCalled()
  })

  it('reports during silence but never heals a healthy-idle main', async () => {
    reportMock.mockResolvedValue(HEALTHY)
    await startWatchdog()

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)

    expect(reportMock).toHaveBeenCalledTimes(4)
    for (const call of reportMock.mock.calls) {
      expect((call[0] as { heal?: boolean }).heal).toBeUndefined()
    }
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('confirms a wedge across two silent ticks, re-attaches, and routes pulled restore markers', async () => {
    reportMock.mockImplementation((args) =>
      Promise.resolve(
        (args as { heal?: boolean }).heal
          ? {
              ...STALLED,
              inFlightTotalChars: 0,
              inFlightPtyCount: 0,
              writtenOff: [{ id: 'pty-1', markerSeq: 42, writtenOffChars: 512 * 1024 }]
            }
          : STALLED
      )
    )
    const { recordPtyDataReceived, registerRestoreHandler } = await startWatchdog()
    const restoreEvents: { id: string; reason: string; markerSeq?: number }[] = []
    registerRestoreHandler('pty-1', (event) => restoreEvents.push(event))

    // Bytes flowed once, then the push channel died: the field shape.
    recordPtyDataReceived('pty-1', 128)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reportMock).not.toHaveBeenCalled()

    // First silent tick: report only, no heal yet.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reattachMock).not.toHaveBeenCalled()

    // Second silent tick confirms: re-attach precedes the heal report, the
    // listener count is captured for field discrimination, and the pulled
    // marker reaches the pane handler without any push event.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reattachMock).toHaveBeenCalledTimes(1)
    const healCalls = reportMock.mock.calls.filter(
      (call) => (call[0] as { heal?: boolean }).heal === true
    )
    expect(healCalls).toHaveLength(1)
    expect(healCalls[0]![0]).toMatchObject({
      heal: true,
      rendererPtyDataListenerCount: 1,
      receivedCharsByPty: { 'pty-1': 128 }
    })
    expect(restoreEvents).toEqual([{ id: 'pty-1', reason: 'delivery-heal', markerSeq: 42 }])
  })

  it('rate-limits heals to the cooldown while the wedge persists', async () => {
    reportMock.mockImplementation((args) =>
      Promise.resolve((args as { heal?: boolean }).heal ? { ...STALLED, writtenOff: [] } : STALLED)
    )
    await startWatchdog()

    const countHeals = (): number =>
      reportMock.mock.calls.filter((call) => (call[0] as { heal?: boolean }).heal === true).length

    // Ticks at 15s/30s: confirm + first heal.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(countHeals()).toBe(1)

    // 45s/60s/75s: streak rebuilds but the 60s cooldown holds.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(countHeals()).toBe(1)

    // 90s: cooldown elapsed — one more heal, not one per tick.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(countHeals()).toBe(2)
    expect(reattachMock).toHaveBeenCalledTimes(2)
  })

  it('stays off when no PTY expects push delivery', async () => {
    reportMock.mockResolvedValue(STALLED)
    const watchdog = await import('./terminal-delivery-watchdog')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => false
    })

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(reportMock).not.toHaveBeenCalled()
  })

  it('never starts without the invoke heal lane (web client, partial mocks)', async () => {
    ;(window.api.pty as { reportRendererDeliveryState?: unknown }).reportRendererDeliveryState =
      undefined
    const watchdog = await import('./terminal-delivery-watchdog')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true
    })

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(reattachMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
