import { describe, expect, it } from 'vitest'
import { availabilityRetryDelay } from './availability-retry'

describe('availabilityRetryDelay', () => {
  it('backs off 5s, 10s, 30s and then holds at 60s', () => {
    expect([0, 1, 2, 3, 4, 50].map(availabilityRetryDelay)).toEqual([
      5_000, 10_000, 30_000, 60_000, 60_000, 60_000
    ])
  })
})
