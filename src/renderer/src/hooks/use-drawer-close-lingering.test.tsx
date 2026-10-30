// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDrawerCloseLingering } from './use-drawer-close-lingering'

describe('drawer close linger', () => {
  afterEach(() => vi.useRealTimers())

  it('cancels the pending release when reopened', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useDrawerCloseLingering(open),
      { initialProps: { open: true } }
    )
    act(() => rerender({ open: false }))
    act(() => vi.advanceTimersByTime(299))
    act(() => rerender({ open: true }))
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })
})
