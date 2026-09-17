import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  markHostSessionMirrorHydrated,
  parkUntilHostSessionMirrorHydrates,
  resetHostSessionMirrorHydrationForTests
} from './host-session-mirror-hydration'

// The same fan-out hazard as host-mirror-handle-gap-drain.test.ts, one module up: settling an
// environment drains every worktree parked on it in one loop, from inside the frame apply. The
// waiters are strangers to each other and to that apply, so one replay must not be able to reach
// either of them.
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
})
