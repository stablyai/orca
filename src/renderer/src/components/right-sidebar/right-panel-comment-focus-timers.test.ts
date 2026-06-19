import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRightPanelCommentFocusTimer,
  scheduleRightPanelCommentFocusTimer,
  type RightPanelCommentFocusTimerRef
} from './right-panel-comment-focus-timers'

function createTimerRef(): RightPanelCommentFocusTimerRef {
  return { current: null }
}

describe('right panel comment focus timers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const callback = vi.fn()

    scheduleRightPanelCommentFocusTimer(timerRef, callback)
    clearRightPanelCommentFocusTimer(timerRef)
    vi.runOnlyPendingTimers()

    expect(timerRef.current).toBeNull()
    expect(callback).not.toHaveBeenCalled()
  })

  it('replaces stale deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const staleCallback = vi.fn()
    const nextCallback = vi.fn()

    scheduleRightPanelCommentFocusTimer(timerRef, staleCallback)
    scheduleRightPanelCommentFocusTimer(timerRef, nextCallback)
    vi.runOnlyPendingTimers()

    expect(staleCallback).not.toHaveBeenCalled()
    expect(nextCallback).toHaveBeenCalledTimes(1)
    expect(timerRef.current).toBeNull()
  })
})
