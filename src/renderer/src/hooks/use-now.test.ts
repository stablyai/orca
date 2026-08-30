// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from './use-now'

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes immediately when enabled after being paused', () => {
    const hook = renderHook(({ enabled }: { enabled: boolean }) => useNow(1_000, enabled), {
      initialProps: { enabled: false }
    })
    expect(hook.result.current).toBe(1_000)

    act(() => vi.advanceTimersByTime(5_000))
    expect(hook.result.current).toBe(1_000)

    vi.setSystemTime(6_000)
    hook.rerender({ enabled: true })
    expect(hook.result.current).toBe(6_000)

    act(() => vi.advanceTimersByTime(1_000))
    expect(hook.result.current).toBe(7_000)
  })
})
