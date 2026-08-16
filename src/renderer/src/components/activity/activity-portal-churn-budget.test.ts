import { describe, expect, it } from 'vitest'
import {
  createActivityPortalChurnBudget,
  type ActivityPortalChurnBudget
} from './activity-portal-churn-budget'

function budgetAt(clock: { ms: number }): ActivityPortalChurnBudget {
  return createActivityPortalChurnBudget({ limit: 3, windowMs: 1_000, now: () => clock.ms })
}

describe('createActivityPortalChurnBudget', () => {
  it('spends once the window holds a full burst', () => {
    const clock = { ms: 0 }
    const budget = budgetAt(clock)
    expect(budget.record()).toBe(false)
    expect(budget.record()).toBe(false)
    expect(budget.record()).toBe(true)
    clock.ms += 900
    expect(budget.isSpent()).toBe(true)
  })

  it('stays spent while the churn keeps firing', () => {
    const clock = { ms: 0 }
    const budget = budgetAt(clock)
    for (let i = 0; i < 500; i += 1) {
      clock.ms += 10
      budget.record()
    }
    expect(budget.isSpent()).toBe(true)
  })

  it('releases a window after the churn stops', () => {
    const clock = { ms: 0 }
    const budget = budgetAt(clock)
    for (let i = 0; i < 3; i += 1) {
      budget.record()
    }
    clock.ms += 1_000
    expect(budget.isSpent()).toBe(false)
    expect(budget.record()).toBe(false)
  })

  it('never spends on events paced slower than the window allows', () => {
    // A user hopping between threads must keep the seamless path, however long they keep hopping.
    const clock = { ms: 0 }
    const budget = budgetAt(clock)
    for (let i = 0; i < 100; i += 1) {
      clock.ms += 500
      expect(budget.record()).toBe(false)
    }
  })

  it('treats a backwards clock as an expired window', () => {
    // Date.now() jumps backwards on NTP/sleep-wake.
    const clock = { ms: 10_000 }
    const budget = budgetAt(clock)
    for (let i = 0; i < 3; i += 1) {
      budget.record()
    }
    clock.ms = 5_000
    expect(budget.isSpent()).toBe(false)
  })

  it('clears on demand', () => {
    const clock = { ms: 0 }
    const budget = budgetAt(clock)
    for (let i = 0; i < 3; i += 1) {
      budget.record()
    }
    budget.clear()
    expect(budget.isSpent()).toBe(false)
  })
})
