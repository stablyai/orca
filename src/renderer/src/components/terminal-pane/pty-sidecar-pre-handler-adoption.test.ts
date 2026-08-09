import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DataPayload = { id: string; data: string; rawLength?: number }
type ExitPayload = { id: string; code: number }

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('PTY sidecar pre-handler adoption', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let dispatchData: ((payload: DataPayload) => void) | null
  let dispatchExit: ((payload: ExitPayload) => void) | null

  beforeEach(() => {
    vi.resetModules()
    dispatchData = null
    dispatchExit = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          ackData: vi.fn(),
          rendererDispatcherReady: vi.fn(),
          onData: vi.fn((callback: (payload: DataPayload) => void) => {
            dispatchData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: ExitPayload) => void) => {
            dispatchExit = callback
            return () => {}
          })
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

  it('adopts buffered data through the current sidecar cohort exactly once', async () => {
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const { drainPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    const responder = vi.fn()
    const adopter = vi.fn()

    ensurePtyDispatcher()
    dispatchData?.({ id: 'pty-adopt-data', data: 'gap' })
    const unsubscribeResponder = subscribeToPtyData('pty-adopt-data', responder)
    const unsubscribeAdopter = subscribeToPtyData('pty-adopt-data', adopter, {
      adoptPreHandlerData: true
    })
    dispatchData?.({ id: 'pty-adopt-data', data: 'live' })

    expect(responder.mock.calls).toEqual([['gap'], ['live']])
    expect(adopter.mock.calls).toEqual([['gap'], ['live']])
    unsubscribeAdopter()
    const replacement = vi.fn()
    const unsubscribeReplacement = subscribeToPtyData('pty-adopt-data', replacement, {
      adoptPreHandlerData: true
    })
    expect(replacement).not.toHaveBeenCalled()
    const laterPrimary = vi.fn()
    drainPreHandlerPtyData('pty-adopt-data', laterPrimary)
    expect(laterPrimary).not.toHaveBeenCalled()

    unsubscribeReplacement()
    unsubscribeResponder()
  })

  it('attempts every buffered chunk for every sidecar before rethrowing', async () => {
    const { ensurePtyDispatcher, ptyDataSidecars } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const { drainPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    const firstError = new Error('first sidecar failed')
    const throwingPeer = vi.fn((data: string) => {
      if (data === 'gap-1') {
        throw firstError
      }
    })
    const peer = vi.fn()
    const adopter = vi.fn((data: string) => {
      if (data === 'gap-1') {
        throw new Error('adopter failed')
      }
    })

    ensurePtyDispatcher()
    dispatchData?.({ id: 'pty-adopt-error', data: 'gap-1' })
    dispatchData?.({ id: 'pty-adopt-error', data: 'gap-2' })
    const unsubscribeThrowingPeer = subscribeToPtyData('pty-adopt-error', throwingPeer)
    const unsubscribePeer = subscribeToPtyData('pty-adopt-error', peer)

    expect(() =>
      subscribeToPtyData('pty-adopt-error', adopter, { adoptPreHandlerData: true })
    ).toThrow(firstError)
    expect(throwingPeer.mock.calls).toEqual([['gap-1'], ['gap-2']])
    expect(peer.mock.calls).toEqual([['gap-1'], ['gap-2']])
    expect(adopter.mock.calls).toEqual([['gap-1'], ['gap-2']])
    expect(ptyDataSidecars.get('pty-adopt-error')?.size).toBe(2)
    const laterPrimary = vi.fn()
    drainPreHandlerPtyData('pty-adopt-error', laterPrimary)
    expect(laterPrimary).not.toHaveBeenCalled()

    unsubscribePeer()
    unsubscribeThrowingPeer()
  })

  it('leaves buffered data untouched when no sidecar opts into adoption', async () => {
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const { drainPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    const watcher = vi.fn()

    ensurePtyDispatcher()
    dispatchData?.({ id: 'pty-default-sidecar', data: 'gap' })
    const unsubscribe = subscribeToPtyData('pty-default-sidecar', watcher)
    const primary = vi.fn()
    drainPreHandlerPtyData('pty-default-sidecar', primary)

    expect(watcher).not.toHaveBeenCalled()
    expect(primary).toHaveBeenCalledWith('gap', undefined)
    unsubscribe()
  })

  it('delivers live data to every sidecar before rethrowing the first error', async () => {
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const firstError = new Error('first live sidecar failed')
    const throwingWatcher = vi.fn(() => {
      throw firstError
    })
    const laterWatcher = vi.fn()

    ensurePtyDispatcher()
    const unsubscribeThrowing = subscribeToPtyData('pty-live-error', throwingWatcher)
    const unsubscribeLater = subscribeToPtyData('pty-live-error', laterWatcher)
    expect(() => dispatchData?.({ id: 'pty-live-error', data: 'live' })).toThrow(firstError)
    expect(throwingWatcher).toHaveBeenCalledWith('live')
    expect(laterWatcher).toHaveBeenCalledWith('live')

    unsubscribeLater()
    unsubscribeThrowing()
  })

  it('delivers adopted data effects before its buffered exit', async () => {
    const { ensurePtyDispatcher, subscribeToPtyExit } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const events: string[] = []
    const exitWatcher = vi.fn(() => events.push('exit'))

    ensurePtyDispatcher()
    dispatchData?.({ id: 'pty-data-before-exit', data: 'final frame' })
    dispatchExit?.({ id: 'pty-data-before-exit', code: 17 })
    subscribeToPtyData(
      'pty-data-before-exit',
      () => setTimeout(() => events.push('data-effect'), 0),
      { adoptPreHandlerData: true }
    )
    subscribeToPtyExit('pty-data-before-exit', exitWatcher, { adoptPreHandlerExit: true })

    expect(events).toEqual([])
    await flushTimers()
    expect(events).toEqual(['data-effect', 'exit'])
    expect(exitWatcher).toHaveBeenCalledWith(17, { hadPrimary: false })
  })

  it('preserves buffered exits when the adopter leaves or a primary registers', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers, ptyExitHandlers, subscribeToPtyExit } =
      await import('./pty-dispatcher')
    const { drainPreHandlerPtyExit } = await import('./pty-pre-handler-buffer')
    const departedWatcher = vi.fn()
    const remountWatcher = vi.fn()

    ensurePtyDispatcher()
    dispatchExit?.({ id: 'pty-departed-adopter', code: 18 })
    const unsubscribeDeparted = subscribeToPtyExit('pty-departed-adopter', departedWatcher, {
      adoptPreHandlerExit: true
    })
    unsubscribeDeparted()
    dispatchExit?.({ id: 'pty-remount-wins', code: 19 })
    const unsubscribeRemount = subscribeToPtyExit('pty-remount-wins', remountWatcher, {
      adoptPreHandlerExit: true
    })
    ptyDataHandlers.set('pty-remount-wins', vi.fn())
    const primaryExit = vi.fn()
    ptyExitHandlers.set('pty-remount-wins', primaryExit)

    await flushTimers()
    const departedOwner = vi.fn()
    drainPreHandlerPtyExit('pty-departed-adopter', departedOwner)
    drainPreHandlerPtyExit('pty-remount-wins', primaryExit)
    expect(departedWatcher).not.toHaveBeenCalled()
    expect(remountWatcher).not.toHaveBeenCalled()
    expect(departedOwner).toHaveBeenCalledWith(18)
    expect(primaryExit).toHaveBeenCalledWith(19)

    unsubscribeRemount()
    ptyDataHandlers.delete('pty-remount-wins')
    ptyExitHandlers.delete('pty-remount-wins')
  })
})
