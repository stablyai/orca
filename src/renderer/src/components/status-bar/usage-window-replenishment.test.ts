import { describe, expect, it, vi } from 'vitest'
import { getUsageWindowReplenishmentLabel } from './usage-window-replenishment'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, values?: { duration: string }) =>
    text.replace('{{duration}}', values?.duration ?? '')
}))

const window = { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null }

describe('usage window replenishment', () => {
  it('preserves reset wording for existing providers', () => {
    expect(getUsageWindowReplenishmentLabel({ ...window, resetsAt: 900_000 }, 0)).toBe(
      'Resets in 15m'
    )
  })
  it('prefers full recharge over the next partial refill', () => {
    expect(
      getUsageWindowReplenishmentLabel({ ...window, refillsAt: 900_000, rechargesAt: 3_600_000 }, 0)
    ).toBe('Full recharge in 1h')
  })
  it('shows when the estimated full recharge is due', () => {
    expect(getUsageWindowReplenishmentLabel({ ...window, rechargesAt: 900_000 }, 900_000)).toBe(
      'Full recharge now'
    )
  })
  it('omits countdowns without a timestamp', () => {
    expect(getUsageWindowReplenishmentLabel(window, 0)).toBeNull()
  })
  it('prefers partial refill wording when both timestamps exist', () => {
    expect(
      getUsageWindowReplenishmentLabel({ ...window, resetsAt: 1_800_000, refillsAt: 900_000 }, 0)
    ).toBe('Next refill in 15m')
  })
})
