import { describe, expect, it } from 'vitest'
import { sampleTeam } from '../plan-billing-fixtures'
import { checkoutPollVerdict, nextPhaseAfterOpen } from './checkout-flow'

const order = { interval: 'month' as const, seats: 2 }

describe('checkoutPollVerdict', () => {
  it('waits until a subscription exists', () => {
    expect(checkoutPollVerdict({ ...sampleTeam, plan: null, status: 'none' })).toBe('waiting')
  })
  it('is paid once the subscription is active or trialing', () => {
    expect(checkoutPollVerdict(sampleTeam)).toBe('paid')
    expect(checkoutPollVerdict({ ...sampleTeam, status: 'trialing' })).toBe('paid')
  })
  it('flags a first invoice that needs action (3-D Secure, decline)', () => {
    expect(checkoutPollVerdict({ ...sampleTeam, status: 'incomplete' })).toBe('needs-attention')
    expect(checkoutPollVerdict({ ...sampleTeam, status: 'past_due' })).toBe('needs-attention')
  })
})

describe('nextPhaseAfterOpen', () => {
  it('awaits payment when the browser opened', () => {
    expect(nextPhaseAfterOpen(order, { status: 'opened' }, 5)).toEqual({
      kind: 'awaiting-payment',
      order,
      since: 5
    })
  })
  it('reports why Checkout could not open', () => {
    expect(nextPhaseAfterOpen(order, { status: 'forbidden' }, 5)).toEqual({
      kind: 'open-failed',
      order,
      result: { status: 'forbidden' }
    })
  })
})
