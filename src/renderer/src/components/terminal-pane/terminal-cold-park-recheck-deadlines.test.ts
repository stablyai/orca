import { describe, expect, it } from 'vitest'
import {
  getTerminalTabColdParkRecheckDelayMs,
  getTerminalWorktreeColdParkRecheckDelayMs
} from './terminal-cold-park-recheck-deadlines'

describe('getTerminalWorktreeColdParkRecheckDelayMs', () => {
  it('returns the next cold-park policy deadline', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('schedules no recheck when the settings kill switch disables parking', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: false,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('wakes at the retention TTL for budget candidates past the ordinary deadlines', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_500,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000,
        retentionTtlMs: 5_000
      })
    ).toBe(3_500)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_500,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  // Why: past the ordinary deadlines nothing else would wake the verdict
  // effect, and the cool-down is what keeps the candidate out of the parked
  // set — without this wakeup a measured worktree never re-parks.
  it('wakes at the measure cool-down deadline when all ordinary deadlines have passed', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_500,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000,
        parkCooldownUntilMs: 2_600
      })
    ).toBe(100)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_500,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000,
        parkCooldownUntilMs: 2_500
      })
    ).toBeNull()
  })
})

describe('getTerminalTabColdParkRecheckDelayMs', () => {
  it('returns the next terminal-tab cold-park policy deadline', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('schedules no recheck when the settings kill switch disables parking', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: false,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('wakes at the measure cool-down deadline when all ordinary deadlines have passed', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_500,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000,
        parkCooldownUntilMs: 2_750
      })
    ).toBe(250)
  })
})
