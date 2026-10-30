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

  // With earlier deadlines exhausted, only the cool-down wakeup lets this worktree park again.
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

  // A damped tab has no other pending wakeup; pin expiry must release it to parking.
  it('wakes at the flip-damping pin deadline when all ordinary deadlines have passed', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_000_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000,
        parkVerdictPinUntilMs: 1_060_000
      })
    ).toBe(60_000)
  })

  // Pins and cool-downs must not delay each other’s earlier wakeup.
  it('takes the nearest of the pin and cool-down deadlines', () => {
    const base = {
      parkingEnabled: true,
      hiddenSinceMs: 1_000,
      nowMs: 2_500,
      coldParkDelayMs: 100,
      hotRetainMs: 1_000
    }
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        ...base,
        parkCooldownUntilMs: 2_750,
        parkVerdictPinUntilMs: 62_500
      })
    ).toBe(250)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        ...base,
        parkCooldownUntilMs: 62_500,
        parkVerdictPinUntilMs: 2_750
      })
    ).toBe(250)
  })
})
