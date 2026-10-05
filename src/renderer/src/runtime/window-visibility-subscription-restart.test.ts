// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import { createWindowVisibilitySubscriptionParking } from './window-visibility-subscription-parking'

function setVisible(visible: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden')
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function subscription() {
  const currents: (() => boolean)[] = []
  const handles: { unsubscribe: ReturnType<typeof vi.fn> }[] = []
  const subscribe = vi.fn<(isCurrent: () => boolean) => Promise<{ unsubscribe: () => void }>>(
    async (isCurrent) => {
      currents.push(isCurrent)
      const handle = { unsubscribe: vi.fn() }
      handles.push(handle)
      return handle
    }
  )
  return { subscribe, currents, handles }
}

describe('targeted subscription restart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisible(true)
  })

  afterEach(() => {
    setVisible(true)
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restarts only the named stream and releases each handle once', async () => {
    const healthy = subscription()
    const recovering = subscription()
    const parking = createWindowVisibilitySubscriptionParking([healthy, recovering])
    await settle()

    parking.restart([1, 1])
    await settle()
    expect(healthy.subscribe).toHaveBeenCalledTimes(1)
    expect(healthy.handles[0]!.unsubscribe).not.toHaveBeenCalled()
    expect(healthy.currents[0]!()).toBe(true)
    expect(recovering.subscribe).toHaveBeenCalledTimes(2)
    expect(recovering.currents[0]!()).toBe(false)
    expect(recovering.handles[0]!.unsubscribe).toHaveBeenCalledTimes(1)

    parking.dispose()
    parking.restart([0, 1])
    expect(healthy.handles[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(recovering.handles[1]!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(recovering.subscribe).toHaveBeenCalledTimes(2)
  })

  it('fences a pending attempt without waiting for its stale promise', async () => {
    let finishOld!: (handle: { unsubscribe: () => void }) => void
    const oldPromise = new Promise<{ unsubscribe: () => void }>((resolve) => {
      finishOld = resolve
    })
    const recovering = subscription()
    let oldCurrent!: () => boolean
    recovering.subscribe.mockImplementationOnce((isCurrent) => {
      oldCurrent = isCurrent
      return oldPromise
    })
    const parking = createWindowVisibilitySubscriptionParking([recovering])
    parking.restart([0])
    await settle()

    expect(recovering.subscribe).toHaveBeenCalledTimes(2)
    expect(oldCurrent()).toBe(false)
    const oldHandle = { unsubscribe: vi.fn() }
    finishOld(oldHandle)
    await settle()
    expect(oldHandle.unsubscribe).toHaveBeenCalledTimes(1)
    expect(recovering.currents[0]!()).toBe(true)
    expect(recovering.handles[0]!.unsubscribe).not.toHaveBeenCalled()
    parking.dispose()
  })

  it('keeps parked streams asleep and preserves the full visibility-resume stagger', async () => {
    const streams = [subscription(), subscription(), subscription()]
    const onVisibilityResume = vi.fn()
    const parking = createWindowVisibilitySubscriptionParking(streams, {
      parkDelayMs: 10,
      visibilityResumeStaggerMs: 50,
      onVisibilityResume
    })
    await settle()
    setVisible(false)
    vi.advanceTimersByTime(10)
    parking.restart([1, 2])
    await settle()
    expect(streams.map((stream) => stream.subscribe.mock.calls.length)).toEqual([1, 1, 1])

    setVisible(true)
    await settle()
    expect(streams.map((stream) => stream.subscribe.mock.calls.length)).toEqual([2, 1, 1])
    parking.restart([1, 2])
    vi.advanceTimersByTime(49)
    expect(streams[1]!.subscribe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await settle()
    expect(streams[1]!.subscribe).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(50)
    await settle()
    expect(streams[2]!.subscribe).toHaveBeenCalledTimes(2)
    expect(onVisibilityResume).toHaveBeenCalledExactlyOnceWith({
      visibilityGeneration: 1,
      restartingSpecIndexes: [0, 1, 2]
    })
    parking.dispose()
  })
})
