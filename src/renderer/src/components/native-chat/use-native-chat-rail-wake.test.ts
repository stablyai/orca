// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatRailWake } from './use-native-chat-rail-wake'

function setup() {
  const hook = renderHook(() => useNativeChatRailWake())
  const rail = document.createElement('div')
  hook.result.current.railRef.current = rail
  return { ...hook.result.current, rail, unmount: hook.unmount }
}

describe('useNativeChatRailWake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lights on input and goes dark after the wake window', () => {
    const { rail, wake } = setup()
    wake()
    expect(rail.dataset.awake).toBe('')
    vi.advanceTimersByTime(299)
    expect('awake' in rail.dataset).toBe(true)
    vi.advanceTimersByTime(1)
    expect('awake' in rail.dataset).toBe(false)
  })

  it('stays lit while scroll events follow a recent input', () => {
    const { rail, wake, sustain } = setup()
    wake()
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100)
      sustain()
    }
    expect('awake' in rail.dataset).toBe(true)
    vi.advanceTimersByTime(300)
    expect('awake' in rail.dataset).toBe(false)
  })

  it('stops sustaining once the input is too old', () => {
    const { rail, wake, sustain } = setup()
    wake()
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100)
      sustain()
    }
    // 1.5 s after input, scroll events no longer extend the wake.
    expect('awake' in rail.dataset).toBe(false)
  })

  it('ignores scroll events with no wake pending', () => {
    const { rail, sustain } = setup()
    sustain()
    vi.advanceTimersByTime(1000)
    expect('awake' in rail.dataset).toBe(false)
  })

  it('clears its timer on unmount', () => {
    const { wake, unmount } = setup()
    wake()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
