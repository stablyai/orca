import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FOREGROUND_BUDGET_WINDOW_MS,
  consumeForegroundImmediateBudget,
  createForegroundImmediateBudget
} from './foreground-output-budgets'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockNow(values: number[]): void {
  const now = vi.spyOn(performance, 'now')
  for (const value of values) {
    now.mockReturnValueOnce(value)
  }
}

describe('consumeForegroundImmediateBudget', () => {
  it('rejects a write once the cap is spent within the window', () => {
    const budget = createForegroundImmediateBudget()
    mockNow([1000, 1100])
    expect(consumeForegroundImmediateBudget(budget, 10, 10)).toBe(true)
    expect(consumeForegroundImmediateBudget(budget, 1, 10)).toBe(false)
  })

  it('rolls over at the exact window boundary', () => {
    const budget = createForegroundImmediateBudget()
    mockNow([1000, 1000 + FOREGROUND_BUDGET_WINDOW_MS])
    expect(consumeForegroundImmediateBudget(budget, 10, 10)).toBe(true)
    expect(consumeForegroundImmediateBudget(budget, 10, 10)).toBe(true)
    expect(budget.chars).toBe(10)
  })
})
