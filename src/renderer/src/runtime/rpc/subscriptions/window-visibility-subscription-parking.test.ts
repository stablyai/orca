// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import { installWindowVisibilitySubscriptionParking } from './window-visibility-subscription-parking'
import { WINDOW_HIDE_PARK_GRACE_MS as WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from '../../../lib/window-park-visibility'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('installWindowVisibilitySubscriptionParking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    setDocumentVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps one pending start and replaces it only after stale settlement', async () => {
    const first = createDeferred<{ unsubscribe: () => void }>()
    const second = createDeferred<{ unsubscribe: () => void }>()
    const firstUnsubscribe = vi.fn()
    const secondUnsubscribe = vi.fn()
    const currents: (() => boolean)[] = []
    const subscribe = vi
      .fn((isCurrent: () => boolean) => {
        currents.push(isCurrent)
        return first.promise
      })
      .mockImplementationOnce((isCurrent) => {
        currents.push(isCurrent)
        return first.promise
      })
      .mockImplementationOnce((isCurrent) => {
        currents.push(isCurrent)
        return second.promise
      })
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe }])

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(currents[0]()).toBe(false)
    setDocumentVisibility('visible')

    first.resolve({ unsubscribe: firstUnsubscribe })
    await settle()
    expect(firstUnsubscribe).toHaveBeenCalled()
    expect(currents[0]()).toBe(false)
    expect(currents[1]()).toBe(true)

    second.resolve({ unsubscribe: secondUnsubscribe })
    await settle()
    dispose()
    expect(secondUnsubscribe).toHaveBeenCalled()
  })
})
