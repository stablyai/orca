import { afterEach, describe, expect, it } from 'vitest'
import {
  DELIBERATE_STOP_HOLD_MS,
  clearDeliberateCloudStop,
  isDeliberateCloudStopHeld,
  noteDeliberateCloudStop,
  resetWorktreeSleepViewForTests
} from './worktree-sleep-view'

afterEach(() => resetWorktreeSleepViewForTests())

// "Reattaching terminal · Down for 10 sec" must not show during a deliberate Sleep or Archive.
describe('deliberate Sleep/Archive hold for the reconnect notices', () => {
  it('holds from the press until it runs out', () => {
    const at = 1_000_000
    noteDeliberateCloudStop('ws', at)
    expect(isDeliberateCloudStopHeld('ws', at + 10_000)).toBe(true)
    expect(isDeliberateCloudStopHeld('ws', at + DELIBERATE_STOP_HOLD_MS)).toBe(false)
    expect(isDeliberateCloudStopHeld('other', at + 10_000)).toBe(false)
    expect(isDeliberateCloudStopHeld(null, at)).toBe(false)
  })

  it('ends when cleared (a wake started, or the sleep did not happen)', () => {
    noteDeliberateCloudStop('ws')
    expect(isDeliberateCloudStopHeld('ws')).toBe(true)
    clearDeliberateCloudStop('ws')
    expect(isDeliberateCloudStopHeld('ws')).toBe(false)
  })
})
