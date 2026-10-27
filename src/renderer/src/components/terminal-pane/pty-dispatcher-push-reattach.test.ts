// Lost push subscriptions produce no receive count or ACK; watchdog reattachment must replace stale listeners to recover the pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))

type DataCallback = (payload: { id: string; data: string; rawLength?: number }) => void

describe('pty dispatcher push-listener reattach and delivery blackhole', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  let dataCallbacks: DataCallback[] = []
  let dataUnsubscribes: ReturnType<typeof vi.fn>[] = []
  const ackDataMock = vi.fn()
  const reportMock = vi.fn(() =>
    Promise.resolve({
      inFlightTotalChars: 0,
      inFlightPtyCount: 0,
      msSinceLastAck: null
    })
  )

  beforeEach(() => {
    vi.resetModules()
    dataCallbacks = []
    dataUnsubscribes = []
    ackDataMock.mockClear()
    reportMock.mockClear()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          ackData: ackDataMock,
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: () => dataCallbacks.length,
          onData: vi.fn((cb: DataCallback) => {
            dataCallbacks.push(cb)
            const unsubscribe = vi.fn()
            dataUnsubscribes.push(unsubscribe)
            return unsubscribe
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          onDeliveryResyncRequest: vi.fn(() => () => {}),
          respondDeliveryResync: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(async () => {
    // Stop the real watchdog interval before this suite removes its mocked window.
    const { stopTerminalDeliveryWatchdog } = await import('./terminal-delivery-watchdog')
    stopTerminalDeliveryWatchdog()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('blackholed delivery reproduces the wedge: no handler dispatch, no ACK ever', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers } = await import('./pty-dispatcher')
    ensurePtyDispatcher()
    const received: string[] = []
    ptyDataHandlers.set('pty-1', (data) => received.push(data))

    dataCallbacks[0]?.({ id: 'pty-1', data: 'before-wedge' })
    expect(received).toEqual(['before-wedge'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)

    const blackhole = (
      window as Window & {
        __terminalDeliveryWatchdog?: { blackhole: (on: boolean) => void }
      }
    ).__terminalDeliveryWatchdog
    expect(blackhole).toBeDefined()
    blackhole!.blackhole(true)

    // Vanished chunks have neither receive count nor ACK, leaving unrepaid main-side debt.
    dataCallbacks[0]?.({ id: 'pty-1', data: 'lost-in-wedge' })
    expect(received).toEqual(['before-wedge'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)

    blackhole!.blackhole(false)
  })

  it('reattach drops stale push subscriptions and binds fresh ones', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers, reattachPtyDispatcherPushListeners } =
      await import('./pty-dispatcher')
    ensurePtyDispatcher()
    const received: string[] = []
    ptyDataHandlers.set('pty-1', (data) => received.push(data))
    expect(dataCallbacks).toHaveLength(1)

    reattachPtyDispatcherPushListeners()

    expect(dataUnsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(dataCallbacks).toHaveLength(2)

    dataCallbacks[1]?.({ id: 'pty-1', data: 'after-reattach' })
    expect(received).toEqual(['after-reattach'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)
  })
})
