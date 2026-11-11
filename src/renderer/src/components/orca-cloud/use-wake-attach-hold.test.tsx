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
const PAST_CAP = WAKE_ATTACH_HOLD_MAX_MS + WAKE_ATTACH_POLL_MS
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

  it('at the cap reconnects the pane once on its own, and only then shows the card', () => {
    const retry = vi.fn(() => true)
    const { result, rerender } = hook(() => false, retry)
    rerender({ wake: { ...waking, phase: 'ready' } })
    expect(result.current.wake?.phase).toBe('connecting')
    act(() => vi.advanceTimersByTime(PAST_CAP))
    // The quiet retry: still Connecting…, no card yet.
    expect(retry).toHaveBeenCalledTimes(1)
    expect(result.current.terminalStalled).toBe(false)
    expect(result.current.wake?.phase).toBe('connecting')
    act(() => vi.advanceTimersByTime(PAST_CAP))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(result.current.terminalStalled).toBe(true)
    expect(result.current.wake?.phase).toBe('failed')
  })

  it('Try again re-runs the attach (not a wake) and waits for the pane once more', () => {
    let attached: boolean | null = false
    const retry = vi.fn(() => true)
    const { result, rerender } = hook(() => attached, retry)
    rerender({ wake: { ...waking, phase: 'ready' } })
    act(() => vi.advanceTimersByTime(PAST_CAP * 2))
    expect(result.current.terminalStalled).toBe(true)
    act(() => result.current.retry())
    expect(retry).toHaveBeenLastCalledWith('ws')
    expect(result.current.terminalStalled).toBe(false)
    expect(result.current.wake?.phase).toBe('connecting')
    attached = true
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS))
    expect(result.current.wake).toBeUndefined()
  })

  it('the card clears by itself once the pane attaches through any path', () => {
    let attached: boolean | null = false
    const retry = vi.fn(() => true)
    const { result, rerender } = hook(() => attached, retry)
    rerender({ wake: { ...waking, phase: 'ready' } })
    act(() => vi.advanceTimersByTime(PAST_CAP * 2))
    expect(result.current.terminalStalled).toBe(true)
    // A restore or account restart brings the pane back; nobody pressed Try again.
    attached = true
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS))
    expect(result.current.terminalStalled).toBe(false)
    expect(result.current.wake).toBeUndefined()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('a restart with no wake in flight never shows the card', () => {
    const retry = vi.fn(() => true)
    const { result } = renderHook(() => useWakeAttachHold('ws', undefined, () => false, retry))
    // The restored pane takes its time to attach; no wake, so nothing holds or fails over it.
    act(() => vi.advanceTimersByTime(PAST_CAP * 3))
    expect(result.current.wake).toBeUndefined()
    expect(result.current.terminalStalled).toBe(false)
    expect(retry).not.toHaveBeenCalled()
  })

  it('an account restart (no wake ready from main) never shows the card', () => {
    const retry = vi.fn(() => true)
    const { result, rerender } = hook(() => false, retry)
    // A wake entry that never settles through main goes away (stale, quiet failure, Dismiss)
    // while the pane respawns for its new account: no hold, no card.
    rerender({ wake: undefined })
    act(() => vi.advanceTimersByTime(PAST_CAP * 3))
    expect(result.current.wake).toBeUndefined()
    expect(result.current.terminalStalled).toBe(false)
    // Nor a `ready` from a different wake than the one seen in flight.
    rerender({ wake: { ...waking, startedAt: T0 } })
    rerender({ wake: { ...waking, startedAt: T0 + 1, phase: 'ready' } })
    act(() => vi.advanceTimersByTime(PAST_CAP * 3))
    expect(result.current.wake).toBeUndefined()
    expect(retry).not.toHaveBeenCalled()
  })

  it('counts only visible time toward the reconnect cap', () => {
    let visibility: DocumentVisibilityState = 'visible'
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    })
    const setVisibility = (next: DocumentVisibilityState): void => {
      visibility = next
      document.dispatchEvent(new Event('visibilitychange'))
    }
    try {
      const { result, rerender } = hook(() => false)
      rerender({ wake: { ...waking, phase: 'ready' } })
      act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS / 2))
      act(() => setVisibility('hidden'))
      // Far past the cap in wall time, but the window was hidden for all of it.
      act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS * 3))
      act(() => setVisibility('visible'))
      expect(result.current.terminalStalled).toBe(false)
      expect(result.current.wake?.phase).toBe('connecting')
      act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS / 2 - WAKE_ATTACH_POLL_MS * 2))
      expect(result.current.terminalStalled).toBe(false)
      act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS * 3))
      // The cap's quiet reconnect, counted in visible time too; the card waits one more cap.
      expect(result.current.terminalStalled).toBe(false)
      act(() => vi.advanceTimersByTime(PAST_CAP))
      expect(result.current.terminalStalled).toBe(true)
    } finally {
      if (descriptor) {
        Object.defineProperty(document, 'visibilityState', descriptor)
      } else {
        Reflect.deleteProperty(document, 'visibilityState')
      }
    }
  })

  it('Dismiss clears the reconnect card', () => {
    const { result, rerender } = hook(() => false)
    rerender({ wake: { ...waking, phase: 'ready' } })
    act(() => vi.advanceTimersByTime(PAST_CAP * 2))
    expect(result.current.terminalStalled).toBe(true)
    act(() => result.current.dismiss())
    expect(result.current.wake).toBeUndefined()
  })
})
