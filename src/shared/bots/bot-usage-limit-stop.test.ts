import { describe, expect, it } from 'vitest'
import { usageLimitStopOf } from './bot-usage-limit-stop'

type Cut = NonNullable<Parameters<typeof usageLimitStopOf>[0]>['usageLimitContinue']

const NOW = 10_000_000
const RESET_A = NOW + 3_600_000
const SWITCHED = NOW - 60_000
const summary = (usageLimitContinue: Cut) => ({ usageLimitContinue })
const cut = (state: NonNullable<Cut>['state'], extra: { continueAt?: number } = {}): Cut => ({
  turnItemId: 'turn-1',
  resetsAt: RESET_A,
  state,
  ...extra
})

describe('usageLimitStopOf', () => {
  it('has no stop without a published limit', () => {
    expect(usageLimitStopOf(undefined, NOW)).toBeNull()
    expect(usageLimitStopOf(summary(undefined), NOW)).toBeNull()
  })

  it.each(['off', 'cancelled', 'failed'] as const)(
    'drops a %s stop once the chat moved to another account (continueAt is past)',
    (state) => {
      expect(usageLimitStopOf(summary(cut(state, { continueAt: SWITCHED })), NOW)).toBeNull()
    }
  )

  it.each(['off', 'cancelled', 'failed'] as const)(
    'still shows a %s stop with the reset when the account never changed',
    (state) => {
      expect(usageLimitStopOf(summary(cut(state)), NOW)).toEqual({ at: RESET_A, auto: false })
    }
  )

  it('shows the later time while the account the chat moved to is spent too', () => {
    const later = RESET_A + 3_600_000
    expect(usageLimitStopOf(summary(cut('off', { continueAt: later })), NOW)).toEqual({
      at: later,
      auto: false
    })
  })

  it('leaves a scheduled stop as it was', () => {
    expect(usageLimitStopOf(summary(cut('scheduled')), NOW)).toEqual({ at: RESET_A, auto: true })
    expect(usageLimitStopOf(summary(cut('scheduled', { continueAt: NOW + 5_000 })), NOW)).toEqual({
      at: NOW + 5_000,
      auto: true
    })
    // A scheduled stop keeps showing through the grace period past its time.
    expect(usageLimitStopOf(summary(cut('scheduled', { continueAt: SWITCHED })), NOW)).toEqual({
      at: SWITCHED,
      auto: true
    })
  })
})
