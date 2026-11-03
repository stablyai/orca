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

  it('fires one minute before expiry', () => {
    const onDue = vi.fn()
    renderHook(() => usePairingOfferExpiry(EXPIRES_AT, onDue))
    act(() => vi.advanceTimersByTime(EXPIRES_AT - 60_000 - T0 - 1))
    expect(onDue).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onDue).toHaveBeenCalledOnce()
  })

  it('waits while hidden and fires on return once due', () => {
    const onDue = vi.fn()
    renderHook(() => usePairingOfferExpiry(EXPIRES_AT, onDue))
    act(() => setVisibility('hidden'))
    act(() => vi.advanceTimersByTime(EXPIRES_AT - T0))
    expect(onDue).not.toHaveBeenCalled()
    act(() => setVisibility('visible'))
    act(() => vi.advanceTimersByTime(0))
    expect(onDue).toHaveBeenCalledOnce()
  })

  it('stops after unmount and never runs without an expiry', () => {
    const onDue = vi.fn()
    const { unmount } = renderHook(() => usePairingOfferExpiry(EXPIRES_AT, onDue))
    renderHook(() => usePairingOfferExpiry(null, onDue))
    unmount()
    act(() => vi.advanceTimersByTime(EXPIRES_AT))
    expect(onDue).not.toHaveBeenCalled()
  })
})
