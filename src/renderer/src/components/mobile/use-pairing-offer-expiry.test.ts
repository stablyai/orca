// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePairingOfferExpiry } from './use-pairing-offer-expiry'

const T0 = 1_000_000
const EXPIRES_AT = T0 + 10 * 60_000

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('usePairingOfferExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    setVisibility('visible')
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('fires soon after the computer wakes from sleep past the refresh time', () => {
    const onDue = vi.fn()
    renderHook(() => usePairingOfferExpiry(EXPIRES_AT, onDue))
    // Sleep moves the wall clock without running timers.
    vi.setSystemTime(EXPIRES_AT + 60 * 60_000)
    act(() => vi.advanceTimersByTime(15_000))
    expect(onDue).toHaveBeenCalledOnce()
  })
})
