// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import {
  isActiveWakePaneAttached,
  registerWakePane,
  resetWakePanesForTests
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
    // A remount registers again under the same leaf; the old session's removal leaves it alone.
    registerWakePane('ws', 'front', { isReady: () => false, isActive: () => true })
    offFront()
    expect(isActiveWakePaneAttached('ws')).toBe(false)
    offBack()
  })
})

describe('useWakeAttachHold', () => {
  it('holds a ready wake as Connecting… until the pane in front re-attaches, keeping its start', () => {
    let attached: boolean | null = false
    const { result, rerender } = renderHook(
      ({ wake }: { wake: CloudWakeProgressEvent | undefined }) =>
        useWakeAttachHold('ws', wake, () => attached),
      { initialProps: start }
    )
    expect(result.current).toBeUndefined()
    rerender({ wake: { ...waking, phase: 'ready', at: T0 + 1_000 } })
    expect(result.current).toMatchObject({ phase: 'connecting', startedAt: waking.startedAt })
    // The store drops the settled wake; the hold stays.
    rerender({ wake: undefined })
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS * 5))
    expect(result.current?.phase).toBe('connecting')
    attached = true
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_POLL_MS))
    expect(result.current).toBeUndefined()
  })

  it('does not hold when the pane is already attached or none is known, nor after a failure', () => {
    let attached: boolean | null = true
    const { result, rerender } = renderHook(
      ({ wake }: { wake: CloudWakeProgressEvent | undefined }) =>
        useWakeAttachHold('ws', wake, () => attached),
      { initialProps: start }
    )
    rerender({ wake: { ...waking, phase: 'ready' } })
    expect(result.current).toBeUndefined()
    attached = null
    rerender({ wake: { ...waking, startedAt: T0 } })
    rerender({ wake: { ...waking, startedAt: T0, phase: 'ready' } })
    expect(result.current).toBeUndefined()
    attached = false
    rerender({ wake: { ...waking, startedAt: T0 + 1 } })
    rerender({ wake: { ...waking, startedAt: T0 + 1, phase: 'failed' } })
    expect(result.current).toBeUndefined()
  })

  it('gives up on a pane that never re-attaches', () => {
    const { result, rerender } = renderHook(
      ({ wake }: { wake: CloudWakeProgressEvent | undefined }) =>
        useWakeAttachHold('ws', wake, () => false),
      { initialProps: start }
    )
    rerender({ wake: { ...waking, phase: 'ready' } })
    expect(result.current?.phase).toBe('connecting')
    act(() => vi.advanceTimersByTime(WAKE_ATTACH_HOLD_MAX_MS + WAKE_ATTACH_POLL_MS))
    expect(result.current).toBeUndefined()
  })
})
