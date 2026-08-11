// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { createElement, useLayoutEffect } from 'react'
import {
  FLOATING_TERMINAL_CLOSE_LINGER_MS,
  useFloatingTerminalCloseLinger
} from './floating-terminal-close-linger'

describe('useFloatingTerminalCloseLinger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays false when the panel starts closed', () => {
    const { result } = renderHook(({ open }) => useFloatingTerminalCloseLinger(open), {
      initialProps: { open: false }
    })

    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(FLOATING_TERMINAL_CLOSE_LINGER_MS)
    })

    expect(result.current).toBe(false)
  })

  it('stays false while the panel is open', () => {
    const { result } = renderHook(({ open }) => useFloatingTerminalCloseLinger(open), {
      initialProps: { open: true }
    })

    expect(result.current).toBe(false)
  })

  it('lingers after a close and clears once the exit transition can finish', () => {
    const { result, rerender } = renderHook(({ open }) => useFloatingTerminalCloseLinger(open), {
      initialProps: { open: true }
    })

    rerender({ open: false })
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(FLOATING_TERMINAL_CLOSE_LINGER_MS - 1)
    })
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(false)
  })

  it('never commits an unmount gap in the close render itself', () => {
    // Why: linger must hold the mount in the exact commit that flips open off;
    // a gap there unmounts the panel and cuts the exit animation.
    const committedMounts: boolean[] = []
    function MountProbe({ open }: { open: boolean }) {
      const lingering = useFloatingTerminalCloseLinger(open)
      const mounted = open || lingering
      useLayoutEffect(() => {
        committedMounts.push(mounted)
      })
      return null
    }

    const view = render(createElement(MountProbe, { open: true }))
    view.rerender(createElement(MountProbe, { open: false }))

    expect(committedMounts).toContain(true)
    expect(committedMounts).not.toContain(false)
  })

  it('clears immediately when the panel reopens mid-linger', () => {
    const { result, rerender } = renderHook(({ open }) => useFloatingTerminalCloseLinger(open), {
      initialProps: { open: true }
    })

    rerender({ open: false })
    expect(result.current).toBe(true)

    rerender({ open: true })
    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(FLOATING_TERMINAL_CLOSE_LINGER_MS)
    })
    expect(result.current).toBe(false)
  })

  it('lingers again on every later close', () => {
    const { result, rerender } = renderHook(({ open }) => useFloatingTerminalCloseLinger(open), {
      initialProps: { open: true }
    })

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(FLOATING_TERMINAL_CLOSE_LINGER_MS)
    })
    expect(result.current).toBe(false)

    rerender({ open: true })
    rerender({ open: false })
    expect(result.current).toBe(true)
  })
})
