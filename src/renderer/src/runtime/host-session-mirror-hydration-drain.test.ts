import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  getParkedHostSessionMirrorWaiterCountForTests,
  markHostSessionMirrorHydrated,
  MAX_PARKED_HOST_SESSION_MIRROR_WAITERS,
  parkUntilHostSessionMirrorHydrates,
  resetHostSessionMirrorHydrationForTests
} from './host-session-mirror-hydration'

// Environment settlement drains unrelated worktree waiters inside frame apply; one throwing replay must not escape or strand siblings (also host-mirror-handle-gap-drain.test.ts).
const ENVIRONMENT_ID = 'env-hydration-drain'

describe('host session mirror hydration drain', () => {
  afterEach(() => {
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  it('settles the remaining parked worktrees when one replay throws', () => {
    const secondReplay = vi.fn()
    parkUntilHostSessionMirrorHydrates(ENVIRONMENT_ID, 'repo::first', () => {
      throw new Error('replay blew up')
    })
    parkUntilHostSessionMirrorHydrates(ENVIRONMENT_ID, 'repo::second', secondReplay)

    expect(() => markHostSessionMirrorHydrated(ENVIRONMENT_ID)).not.toThrow()
    expect(secondReplay).toHaveBeenCalledTimes(1)
  })

  it('bounds parked waiter growth when environments churn', () => {
    for (let index = 0; index < MAX_PARKED_HOST_SESSION_MIRROR_WAITERS + 4; index += 1) {
      parkUntilHostSessionMirrorHydrates(`env-${index}`, 'repo::worktree', () => {})
    }

    expect(getParkedHostSessionMirrorWaiterCountForTests()).toBe(
      MAX_PARKED_HOST_SESSION_MIRROR_WAITERS
    )
  })
})
