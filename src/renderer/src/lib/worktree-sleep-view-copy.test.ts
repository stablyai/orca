// SLEEP-IN-PROGRESS: a sleeping workspace's read-only copy is "saving" from the Sleep press until a
// copy at least that new is read back, and "failed" if none arrives in time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SLEEP_COPY_DEADLINE_MS,
  clearSleepCopySave,
  markSleepCopySaving,
  noteSleepCopyRead,
  resetWorktreeSleepViewForTests,
  sleepCopySave
} from './worktree-sleep-view'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorktreeSleepViewForTests()
})
afterEach(() => {
  resetWorktreeSleepViewForTests()
  vi.useRealTimers()
})

describe('the read-only copy saved on Sleep', () => {
  it('is saving until a copy at least as new as the press is read back', () => {
    markSleepCopySaving('ws', 1_000)
    expect(sleepCopySave('ws')).toEqual({ state: 'saving', since: 1_000 })
    noteSleepCopyRead('ws', null)
    noteSleepCopyRead('ws', 999)
    expect(sleepCopySave('ws')?.state).toBe('saving')
    noteSleepCopyRead('ws', 1_000)
    expect(sleepCopySave('ws')).toBeNull()
  })

  it('fails when no copy arrives within the deadline', () => {
    markSleepCopySaving('ws', 1_000)
    vi.advanceTimersByTime(SLEEP_COPY_DEADLINE_MS - 1)
    expect(sleepCopySave('ws')?.state).toBe('saving')
    vi.advanceTimersByTime(1)
    expect(sleepCopySave('ws')).toEqual({ state: 'failed', since: 1_000 })
    // A copy that does arrive later still ends it.
    noteSleepCopyRead('ws', 2_000)
    expect(sleepCopySave('ws')).toBeNull()
  })

  it('a sleep that did not happen clears it, and its deadline never fires', () => {
    markSleepCopySaving('ws', 1_000)
    clearSleepCopySave('ws')
    vi.advanceTimersByTime(SLEEP_COPY_DEADLINE_MS)
    expect(sleepCopySave('ws')).toBeNull()
  })
})
