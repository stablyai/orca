// Why: the Phase-4 hidden-delivery gate only drops bytes while NO renderer
// party needs them. These tests pin the dispatcher-side interest signal: every
// subscribeToPtyData sidecar must surface a ref-counted delivery-interest hold
// to main. Eager buffers are model-recoverable and must not defeat hidden gating.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('pty dispatcher delivery interest', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let setPtyDeliveryInterest: ReturnType<typeof vi.fn>
  let exitCallback: ((payload: { id: string; code: number }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    exitCallback = null
    setPtyDeliveryInterest = vi.fn()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          setPtyDeliveryInterest,
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((cb: (payload: { id: string; code: number }) => void) => {
            exitCallback ??= cb
            return () => {}
          }),
          ackData: vi.fn()
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

  it('registers interest on the first sidecar and releases on the last unsubscribe', async () => {
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')

    const unsubscribeFirst = subscribeToPtyData('pty-1', vi.fn())
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(1)
    expect(setPtyDeliveryInterest).toHaveBeenCalledWith('pty-1', true)

    // Why: ref-counted — main only sees the 0↔1 transitions.
    const unsubscribeSecond = subscribeToPtyData('pty-1', vi.fn())
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(1)
    unsubscribeSecond()
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(2)
    expect(setPtyDeliveryInterest).toHaveBeenLastCalledWith('pty-1', false)
  })

  it('releases sidecar interest only once for repeated unsubscribes', async () => {
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')

    const unsubscribe = subscribeToPtyData('pty-1', vi.fn())
    unsubscribe()
    unsubscribe()

    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(2)
    expect(setPtyDeliveryInterest).toHaveBeenLastCalledWith('pty-1', false)
  })

  it('does not let an eager pre-mount buffer defeat hidden delivery gating', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')

    const handle = registerEagerPtyBuffer('pty-eager', vi.fn())
    expect(setPtyDeliveryInterest).not.toHaveBeenCalled()

    handle.dispose()
    expect(setPtyDeliveryInterest).not.toHaveBeenCalled()
  })

  it('keeps eager buffers outside delivery interest when the PTY exits before mount', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')

    registerEagerPtyBuffer('pty-eager', vi.fn())
    expect(setPtyDeliveryInterest).not.toHaveBeenCalled()

    exitCallback?.({ id: 'pty-eager', code: 0 })
    expect(setPtyDeliveryInterest).not.toHaveBeenCalled()
  })

  it('lets a sidecar exclusively own interest while an eager buffer overlaps', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')

    const handle = registerEagerPtyBuffer('pty-1', vi.fn())
    const unsubscribe = subscribeToPtyData('pty-1', vi.fn())
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(1)

    handle.dispose()
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(setPtyDeliveryInterest).toHaveBeenCalledTimes(2)
    expect(setPtyDeliveryInterest).toHaveBeenLastCalledWith('pty-1', false)
  })
})
