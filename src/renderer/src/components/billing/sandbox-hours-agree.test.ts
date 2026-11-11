// JA-07: home, Plan & billing, the composer and the account menu once showed four numbers for the
// same hours. Every surface now goes through one rounding rule; these pin it.
import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { OrcaBillingUsageHistory } from '../../../../shared/orca-billing'
import { getOrcaCloudHoursLeft } from '../new-workspace/orca-cloud-run-target-access'
import { formatHoursUsed, sandboxHoursLeft, sandboxHoursUsed } from './plan-billing-format'
import { sandboxHoursCount } from './plan-billing-usage-copy'

const HOUR = 3600

describe('sandbox hours: one rule on every surface', () => {
  it('rounds left down and used up, in tenths', () => {
    expect(sandboxHoursLeft(177.38 * HOUR)).toBe(177.3)
    expect(sandboxHoursUsed(2.62 * HOUR)).toBe(2.7)
    expect(formatHoursUsed(2.62 * HOUR)).toBe('2.7')
    expect(sandboxHoursLeft(41 * HOUR)).toBe(41)
    expect(sandboxHoursUsed(3 * HOUR)).toBe(3)
  })

  it('keeps the last minutes visible and never goes negative', () => {
    expect(sandboxHoursLeft(60)).toBe(0.1)
    expect(sandboxHoursLeft(0)).toBe(0)
    expect(sandboxHoursLeft(-5)).toBe(0)
    expect(sandboxHoursUsed(1)).toBe(0.1)
    expect(sandboxHoursUsed(0)).toBe(0)
  })

  it('composer and account menu agree with Plan & billing', () => {
    for (const left of [0.04, 0.5, 9.95, 10.04, 177.38, 177.42, 179.99]) {
      const seconds = left * HOUR
      expect(getOrcaCloudHoursLeft(seconds)).toBe(sandboxHoursCount(seconds))
    }
  })

  // The one exception is the last six minutes, where "left" holds at 0.1 on purpose.
  it('used plus left adds up to the included hours', () => {
    const included = 180 * HOUR
    for (const usedSeconds of [1, 9420, 2.62 * HOUR, 90 * HOUR + 7, 179.8 * HOUR + 1]) {
      const total = sandboxHoursUsed(usedSeconds) + sandboxHoursLeft(included - usedSeconds)
      expect(Math.round(total * 10) / 10).toBe(180)
    }
  })

  // JA-07 re-run: member page showed "18 used" beside "17.9 in 30 days" for the same usage.
  it('usage amounts on Plan & billing round like "used"', async () => {
    const { usageWindowTotalLine, yourUsageLine } = await import('./plan-billing-usage-history')
    const t: Translate = (_key, fallback, values) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
    const seconds = 17.94 * HOUR
    const history: OrcaBillingUsageHistory = {
      days: [],
      totalSeconds: seconds,
      yourSeconds: seconds,
      members: null,
      sandboxes: null
    }
    expect(formatHoursUsed(seconds)).toBe('18')
    expect(usageWindowTotalLine(seconds, t)).toContain('18 sandbox hours in 30 days')
    expect(yourUsageLine(history, t)).toContain('You used 18 of')
  })
})

