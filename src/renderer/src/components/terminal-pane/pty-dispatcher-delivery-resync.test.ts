// Why: pins the renderer half of the delivery-resync protocol — the singleton
// dispatcher must answer main's probe with the cumulative processed totals
// that back its ACKs, and must drop a PTY's total once it exits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('pty dispatcher delivery resync', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  let dataCallback:
    | ((payload: { id: string; data: string; rawLength?: number; background?: boolean }) => void)
    | null = null
  let exitCallback: ((payload: { id: string; code: number }) => void) | null = null
  let resyncRequestCallback: ((payload: { requestId: number }) => void) | null = null
  const ackDataMock = vi.fn()
  const respondDeliveryResyncMock = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    dataCallback = null
    exitCallback = null
    resyncRequestCallback = null
    ackDataMock.mockClear()
    respondDeliveryResyncMock.mockClear()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          ackData: ackDataMock,
          onData: vi.fn(
            (
              cb: (payload: {
                id: string
                data: string
                rawLength?: number
                background?: boolean
              }) => void
            ) => {
              dataCallback ??= cb
              return () => {}
            }
          ),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((cb: (payload: { id: string; code: number }) => void) => {
            exitCallback ??= cb
            return () => {}
          }),
          onDeliveryResyncRequest: vi.fn((cb: (payload: { requestId: number }) => void) => {
            resyncRequestCallback ??= cb
            return () => {}
          }),
          respondDeliveryResync: respondDeliveryResyncMock
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('answers delivery resync probes with cumulative totals and drops exited PTYs', async () => {
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    ensurePtyDispatcher()

    dataCallback?.({ id: 'pty-1', data: 'hello' })
    dataCallback?.({ id: 'pty-1', data: 'world!!', rawLength: 7 })
    dataCallback?.({ id: 'pty-2', data: 'abc' })

    expect(ackDataMock).toHaveBeenNthCalledWith(1, 'pty-1', 5, 5)
    expect(ackDataMock).toHaveBeenNthCalledWith(2, 'pty-1', 7, 12)
    expect(ackDataMock).toHaveBeenNthCalledWith(3, 'pty-2', 3, 3)

    resyncRequestCallback?.({ requestId: 7 })
    expect(respondDeliveryResyncMock).toHaveBeenCalledWith({
      requestId: 7,
      processedCharsByPty: { 'pty-1': 12, 'pty-2': 3 }
    })

    exitCallback?.({ id: 'pty-1', code: 0 })
    resyncRequestCallback?.({ requestId: 8 })
    expect(respondDeliveryResyncMock).toHaveBeenLastCalledWith({
      requestId: 8,
      processedCharsByPty: { 'pty-2': 3 }
    })
  })
})
