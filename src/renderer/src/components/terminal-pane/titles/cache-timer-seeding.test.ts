import { describe, expect, it } from 'vitest'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'

describe('shouldSeedCacheTimerOnInitialTitle', () => {
  it('does not seed for fresh Claude tabs that have not been restored', () => {
    expect(
      shouldSeedCacheTimerOnInitialTitle({
        rawTitle: '✳ Claude Code',
        allowInitialIdleSeed: false,
        existingTimerStartedAt: null,
        promptCacheTimerEnabled: true
      })
    ).toBe(false)
  })

  it('seeds for restored Claude tabs that are already idle', () => {
    expect(
      shouldSeedCacheTimerOnInitialTitle({
        rawTitle: '✳ Claude Code',
        allowInitialIdleSeed: true,
        existingTimerStartedAt: null,
        promptCacheTimerEnabled: true
      })
    ).toBe(true)
  })

  it('does not seed for restored Claude tabs that are still working', () => {
    expect(
      shouldSeedCacheTimerOnInitialTitle({
        rawTitle: '⠂ Claude Code',
        allowInitialIdleSeed: true,
        existingTimerStartedAt: null,
        promptCacheTimerEnabled: true
      })
    ).toBe(false)
  })

  it('does not seed when a timer already exists for the pane', () => {
    expect(
      shouldSeedCacheTimerOnInitialTitle({
        rawTitle: '✳ Claude Code',
        allowInitialIdleSeed: true,
        existingTimerStartedAt: Date.now(),
        promptCacheTimerEnabled: true
      })
    ).toBe(false)
  })

  it('treats null settings as provisionally enabled during startup hydration', () => {
    expect(
      shouldSeedCacheTimerOnInitialTitle({
        rawTitle: '✳ Claude Code',
        allowInitialIdleSeed: true,
        existingTimerStartedAt: null,
        promptCacheTimerEnabled: null
      })
    ).toBe(true)
  })
})
