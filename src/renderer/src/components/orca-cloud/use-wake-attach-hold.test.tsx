// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import {
  isActiveWakePaneAttached,
  registerWakePane,
  resetWakePanesForTests,
  retryActiveWakePane
} from '@/components/terminal-pane/input/wake-pane-attach'
import {
  WAKE_ATTACH_HOLD_MAX_MS,
  WAKE_ATTACH_POLL_MS,
  useWakeAttachHold
} from './use-wake-attach-hold'

const T0 = 1_800_000_000_000
const waking: CloudWakeProgressEvent = {
  workspaceId: 'ws',
  phase: 'waking',
  source: 'open',
  startedAt: T0 - 5_000,
  at: T0
}
const start: { wake: CloudWakeProgressEvent | undefined } = { wake: waking }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetWakePanesForTests()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('wake pane registry', () => {
  it('answers for the pane in front only, null when none is known, and keeps a remount’s entry', () => {
    expect(isActiveWakePaneAttached('ws')).toBeNull()
    let frontReady = false
    const offBack = registerWakePane('ws', 'back', { isReady: () => true, isActive: () => false })
    expect(isActiveWakePaneAttached('ws')).toBeNull()
    const offFront = registerWakePane('ws', 'front', {
      isReady: () => frontReady,
      isActive: () => true
    })
    expect(isActiveWakePaneAttached('ws')).toBe(false)
    frontReady = true
    expect(isActiveWakePaneAttached('ws')).toBe(true)
    // Try again reaches the pane in front only.
    expect(retryActiveWakePane('ws')).toBe(false)
    // A remount registers again under the same leaf; the old session's removal leaves it alone.
    registerWakePane('ws', 'front', { isReady: () => false, isActive: () => true })
    offFront()
    expect(isActiveWakePaneAttached('ws')).toBe(false)
    offBack()
  })
})

describe('useWakeAttachHold', () => {
  const hook = (read: () => boolean | null, retry = vi.fn(() => true)) => {
    const isAttached = (): boolean | null => read()
    return renderHook(
      ({ wake }: { wake: CloudWakeProgressEvent | undefined }) =>
        useWakeAttachHold('ws', wake, isAttached, retry),
      { initialProps: start }
    )
  }

  it('holds a ready wake as Connecting… until the pane in front takes input, keeping its start', () => {
    let attached: boolean | null = false
    const { result, rerender } = hook(() => attached)
    expect(result.current.wake).toBeUndefined()
    rerender({ wake: { ...waking, phase: 'ready', at: T0 + 1_000 } })
    expect(result.current.wake).toMatchObject({ phase: 'connecting', startedAt: waking.startedAt })
    // The store drops the settled wake; the hold stays.
    rerender({ wake: undefined })
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS * 5))
    expect(result.current.wake?.phase).toBe('connecting')
    attached = true
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS))
    expect(result.current.wake).toBeUndefined()
    expect(result.current.terminalStalled).toBe(false)
  })

  it('does not hold when the pane is already attached or none is known, nor after a failure', () => {
    let attached: boolean | null = true
    const { result, rerender } = hook(() => attached)
    rerender({ wake: { ...waking, phase: 'ready' } })
    expect(result.current.wake).toBeUndefined()
    attached = null
    rerender({ wake: { ...waking, startedAt: T0 } })
    rerender({ wake: { ...waking, startedAt: T0, phase: 'ready' } })
    expect(result.current.wake).toBeUndefined()
    attached = false
    rerender({ wake: { ...waking, startedAt: T0 + 1 } })
    rerender({ wake: { ...waking, startedAt: T0 + 1, phase: 'failed' } })
    expect(result.current.wake).toBeUndefined()
  })

  it('a pane that never takes input becomes "Couldn’t reconnect the terminal"; Try again reconnects it', () => {
    let attached: boolean | null = false
    const retry = vi.fn(() => true)
    const { result, rerender } = hook(() => attached, retry)
    rerender({ wake: { ...waking, phase: 'ready' } })
    expect(result.current.wake?.phase).toBe('connecting')
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS + WAKE_ATTACH_POLL_MS))
    expect(result.current.terminalStalled).toBe(true)
    expect(result.current.wake?.phase).toBe('failed')
    // Try again: the pane reconnects and the pill waits for it once more.
    act(() => result.current.retry())
    expect(retry).toHaveBeenCalledWith('ws')
    expect(result.current.terminalStalled).toBe(false)
    expect(result.current.wake?.phase).toBe('connecting')
    attached = true
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS))
    expect(result.current.wake).toBeUndefined()
  })

  it('Dismiss clears the reconnect card', () => {
    const { result, rerender } = hook(() => false)
    rerender({ wake: { ...waking, phase: 'ready' } })
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS + WAKE_ATTACH_POLL_MS))
    act(() => result.current.dismiss())
    expect(result.current.wake).toBeUndefined()
  })
})
