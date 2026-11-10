import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { sampleTeam } from './plan-billing-fixtures'
import {
  accountMenuUsageLines,
  includedUsageTone,
  sandboxHoursCount,
  sandboxHoursLeftLine,
  sandboxHoursOverLine,
  usageWarningLine
} from './plan-billing-usage-copy'

const HOUR = 3600
const t = translate
const team = (patch: Partial<OrcaBillingEntitlement>): OrcaBillingEntitlement => ({
  ...sampleTeam,
  ...patch
})

describe('sandbox hours copy', () => {
  it('counts hours to one decimal', () => {
    expect(sandboxHoursCount(78.5 * HOUR)).toBe(78.5)
    expect(sandboxHoursCount(HOUR + 1)).toBe(1)
    expect(sandboxHoursCount(-5)).toBe(0)
  })

  it('pluralizes the hours left', () => {
    expect(sandboxHoursLeftLine(team({ remainingIncludedSeconds: 78.5 * HOUR }), t)).toBe(
      '78.5 sandbox hours left'
    )
    expect(sandboxHoursLeftLine(team({ remainingIncludedSeconds: HOUR }), t)).toBe(
      '1 sandbox hour left'
    )
    expect(sandboxHoursLeftLine(team({ remainingIncludedSeconds: 0 }), t)).toBe(
      '0 sandbox hours left'
    )
  })

  it('says how far over the included amount the team is, billed or not', () => {
    expect(sandboxHoursOverLine(team({}), t)).toBeNull()
    expect(
      sandboxHoursOverLine(team({ usedSeconds: 123 * HOUR, overageSeconds: 3 * HOUR }), t)
    ).toBe('3 sandbox hours over the included amount this month')
    expect(sandboxHoursOverLine(team({ usedSeconds: 121 * HOUR, overageSeconds: 0 }), t)).toBe(
      '1 sandbox hour over the included amount this month'
    )
  })

  it('warns at the level billing reports until the hours run out', () => {
    expect(usageWarningLine(team({ usageWarningPercent: null }), t)).toBeNull()
    expect(usageWarningLine(team({ usageWarningPercent: 75 }), t)).toBe(
      'Your team has used 75% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usageWarningPercent: 90 }), t)).toBe(
      'Your team has used 90% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usageWarningPercent: 80 }), t)).toBe(
      'Your team has used 80% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usageWarningPercent: 100 }), t)).toBeNull()
  })

  it('states the actual share used, floored, not the level that triggered it', () => {
    expect(usageWarningLine(team({ usedSeconds: 119 * HOUR, usageWarningPercent: 90 }), t)).toBe(
      'Your team has used 99% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usedSeconds: 92 * HOUR, usageWarningPercent: 75 }), t)).toBe(
      'Your team has used 76% of this month’s sandbox hours.'
    )
    // Never "100%" while billing still reports hours left.
    expect(usageWarningLine(team({ usedSeconds: 119.9 * HOUR, usageWarningPercent: 90 }), t)).toBe(
      'Your team has used 99% of this month’s sandbox hours.'
    )
  })

  it('turns the hours bar to the warning tone at 90%', () => {
    expect(includedUsageTone(team({ usedSeconds: 107 * HOUR }))).toBe('default')
    expect(includedUsageTone(team({ usedSeconds: 108 * HOUR }))).toBe('warning')
    expect(includedUsageTone(team({ usedSeconds: 200 * HOUR }))).toBe('warning')
  })

  it('gives the account menu hours and the usage warning only on a plan', () => {
    expect(
      accountMenuUsageLines(
        {
          status: 'ok',
          entitlement: team({ remainingIncludedSeconds: 20 * HOUR, usageWarningPercent: 90 })
        },
        t
      )
    ).toEqual({
      hoursLeft: '20 sandbox hours left',
      warning: 'Your team has used 90% of this month’s sandbox hours.'
    })
    expect(
      accountMenuUsageLines(
        { status: 'ok', entitlement: team({ plan: null, planLabel: null, status: 'none' }) },
        t
      )
    ).toBeNull()
    expect(accountMenuUsageLines({ status: 'failed', error: 'offline' }, t)).toBeNull()
  })
})
