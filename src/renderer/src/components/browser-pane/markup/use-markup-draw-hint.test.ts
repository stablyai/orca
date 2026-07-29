/** @vitest-environment happy-dom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const HINT_KEY = 'orca.browser.markup-draw-hint-seen'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { persistedUIReady: boolean }) => unknown) =>
    selector({ persistedUIReady: true })
}))

import { useMarkupDrawHint } from './use-markup-draw-hint'

describe('useMarkupDrawHint', () => {
  beforeEach(() => {
    window.localStorage.removeItem(HINT_KEY)
  })

  afterEach(() => {
    window.localStorage.removeItem(HINT_KEY)
  })

  it('opens once when eligible and records the seen flag', () => {
    const { result } = renderHook(() => useMarkupDrawHint(true))

    expect(result.current.hintOpen).toBe(true)
    expect(window.localStorage.getItem(HINT_KEY)).toBe('true')
  })

  it('does not open when the surface is not eligible', () => {
    const { result } = renderHook(() => useMarkupDrawHint(false))

    expect(result.current.hintOpen).toBe(false)
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull()
  })

  it('closes when eligibility drops so a hidden pane cannot keep it open', () => {
    const { result, rerender } = renderHook(({ eligible }) => useMarkupDrawHint(eligible), {
      initialProps: { eligible: true }
    })

    expect(result.current.hintOpen).toBe(true)

    rerender({ eligible: false })
    expect(result.current.hintOpen).toBe(false)
  })

  it('dismisses without reopening after the first view', () => {
    const first = renderHook(() => useMarkupDrawHint(true))
    expect(first.result.current.hintOpen).toBe(true)

    act(() => {
      first.result.current.dismissHint()
    })
    expect(first.result.current.hintOpen).toBe(false)
    first.unmount()

    const second = renderHook(() => useMarkupDrawHint(true))
    expect(second.result.current.hintOpen).toBe(false)
  })
})
