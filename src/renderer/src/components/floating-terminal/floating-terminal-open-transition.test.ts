// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import {
  FLOATING_TERMINAL_CLOSE_TRANSITION_MS,
  useFloatingTerminalOpenTransition
} from './floating-terminal-open-transition'

const CLOSE_SETTLE_MS = FLOATING_TERMINAL_CLOSE_TRANSITION_MS + 50

function renderTransition(open: boolean) {
  const panelRef = createRef<HTMLElement | null>()
  return renderHook(({ open: current }) => useFloatingTerminalOpenTransition(current, panelRef), {
    initialProps: { open }
  })
}

describe('useFloatingTerminalOpenTransition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts hidden with closed visuals when mounted closed', () => {
    const { result } = renderTransition(false)

    expect(result.current.visualOpen).toBe(false)
    expect(result.current.hidden).toBe(true)
  })

  it('mounts visible and settles into open visuals before paint', () => {
    const { result } = renderTransition(true)

    expect(result.current.hidden).toBe(false)
    expect(result.current.visualOpen).toBe(true)
  })

  it('drops open visuals immediately on close but stays visible until the transition settles', () => {
    const { result, rerender } = renderTransition(true)

    rerender({ open: false })
    expect(result.current.visualOpen).toBe(false)
    expect(result.current.hidden).toBe(false)

    act(() => {
      vi.advanceTimersByTime(CLOSE_SETTLE_MS - 1)
    })
    expect(result.current.hidden).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.hidden).toBe(true)
  })

  it('reopening mid-close cancels the pending hide and returns to open visuals', () => {
    const { result, rerender } = renderTransition(true)

    rerender({ open: false })
    expect(result.current.hidden).toBe(false)

    rerender({ open: true })
    expect(result.current.hidden).toBe(false)
    expect(result.current.visualOpen).toBe(true)

    act(() => {
      vi.advanceTimersByTime(CLOSE_SETTLE_MS)
    })

    expect(result.current.hidden).toBe(false)
    expect(result.current.visualOpen).toBe(true)
  })

  it('hides again on every later close', () => {
    const { result, rerender } = renderTransition(true)

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(CLOSE_SETTLE_MS)
    })
    expect(result.current.hidden).toBe(true)

    rerender({ open: true })
    expect(result.current.hidden).toBe(false)

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(CLOSE_SETTLE_MS)
    })
    expect(result.current.hidden).toBe(true)
  })
})
