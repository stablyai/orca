// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  startHostTerminalScrollbackHydration
} from '@/runtime/host-terminal-scrollback-hydration'
import { useHostTerminalScrollbackHold } from './use-host-terminal-scrollback-hold'

vi.mock('@/runtime/host-terminal-scrollback-hydration', () => ({
  HOST_TERMINAL_SCROLLBACK_HOLD_MS: 3_000,
  startHostTerminalScrollbackHydration: vi.fn()
}))
const start = vi.mocked(startHostTerminalScrollbackHydration)

afterEach(() => {
  cleanup()
  start.mockReset()
  vi.useRealTimers()
})

describe('useHostTerminalScrollbackHold', () => {
  it('mounts at once when there is nothing to read from a host', () => {
    start.mockReturnValue(null)
    const { result } = renderHook(() => useHostTerminalScrollbackHold('tab-1', 'wt-1'))
    expect(result.current).toBe(false)
  })

  it('holds the mount until the host read settles', async () => {
    let settle = (): void => {}
    start.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve
      })
    )
    const { result } = renderHook(() => useHostTerminalScrollbackHold('tab-1', 'wt-1'))
    expect(result.current).toBe(true)
    await act(async () => settle())
    expect(result.current).toBe(false)
    expect(start).toHaveBeenCalledWith('tab-1', 'wt-1')
  })

  it('stops holding after the bound even if the host never answers', () => {
    vi.useFakeTimers()
    start.mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useHostTerminalScrollbackHold('tab-1', 'wt-1'))
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(HOST_TERMINAL_SCROLLBACK_HOLD_MS)
    })
    expect(result.current).toBe(false)
  })
})
