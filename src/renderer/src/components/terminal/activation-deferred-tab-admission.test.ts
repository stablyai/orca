import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVATION_DEFERRED_ADMISSION_LIMIT,
  isActivationAdmissionEligible,
  pickNextActivationDeferredTabId,
  scheduleActivationDeferredAdmission
} from './activation-deferred-tab-admission'
import {
  planColdActivationTabDeferral,
  revealActivationDeferredTabs
} from './background-terminal-worktree-mount'

const tabIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `tab-${index + 1}`)

/** Runs the scheduler against timers instead of idle callbacks. */
function withoutIdleCallbacks(run: () => void): void {
  const originalRequest = globalThis.requestIdleCallback
  const originalCancel = globalThis.cancelIdleCallback
  vi.useFakeTimers()
  try {
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.requestIdleCallback = undefined
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.cancelIdleCallback = undefined
    run()
  } finally {
    globalThis.requestIdleCallback = originalRequest
    globalThis.cancelIdleCallback = originalCancel
    vi.useRealTimers()
  }
}

describe('activation-deferred tab admission', () => {
  it('picks deferred tabs in tab order', () => {
    expect(pickNextActivationDeferredTabId(tabIds(4), new Set(['tab-4', 'tab-2']))).toBe('tab-2')
  })

  it('reports nothing to admit for an empty, absent, or stale deferred set', () => {
    expect(pickNextActivationDeferredTabId(tabIds(3), new Set())).toBeNull()
    expect(pickNextActivationDeferredTabId(tabIds(3), null)).toBeNull()
    expect(pickNextActivationDeferredTabId(tabIds(2), new Set(['tab-9']))).toBeNull()
  })

  it('only warms up a deferred population the pre-deferral behaviour would have mounted', () => {
    expect(isActivationAdmissionEligible(0)).toBe(false)
    expect(isActivationAdmissionEligible(ACTIVATION_DEFERRED_ADMISSION_LIMIT)).toBe(true)
    expect(isActivationAdmissionEligible(ACTIVATION_DEFERRED_ADMISSION_LIMIT + 1)).toBe(false)
  })

  // The contract that makes deferral free: repeated admission ends with the
  // worktree exactly as fully mounted as it would have been without deferral.
  it('drains to a fully mounted worktree with no restriction left behind', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const allTabIds = tabIds(4)
    planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds,
      isTabLive: () => false,
      isTabDeferrable: () => true,
      immediateTabIds: new Set(['tab-1'])
    })
    expect(deferredMountTabIdsByWorktree.get('wt-1')?.size).toBe(3)

    const admitted: string[] = []
    for (let step = 0; step < allTabIds.length; step += 1) {
      const nextTabId = pickNextActivationDeferredTabId(
        allTabIds,
        deferredMountTabIdsByWorktree.get('wt-1')
      )
      if (!nextTabId) {
        break
      }
      admitted.push(nextTabId)
      revealActivationDeferredTabs({
        restrictions,
        deferredMountTabIdsByWorktree,
        worktreeId: 'wt-1',
        allTabIds,
        immediateTabIds: new Set([nextTabId])
      })
    }

    expect(admitted).toEqual(['tab-2', 'tab-3', 'tab-4'])
    expect(restrictions.has('wt-1')).toBe(false)
    expect(deferredMountTabIdsByWorktree.has('wt-1')).toBe(false)
  })

  it('falls back to a timer when idle callbacks are unavailable', () => {
    withoutIdleCallbacks(() => {
      let ran = false
      scheduleActivationDeferredAdmission(() => {
        ran = true
      })
      vi.advanceTimersByTime(1)
      expect(ran).toBe(true)
    })
  })

  it('cancels a scheduled admission before it can run', () => {
    withoutIdleCallbacks(() => {
      const cancel = scheduleActivationDeferredAdmission(() => {
        throw new Error('cancelled admission must not run')
      })
      cancel()
      vi.advanceTimersByTime(1_000)
    })
  })
})
