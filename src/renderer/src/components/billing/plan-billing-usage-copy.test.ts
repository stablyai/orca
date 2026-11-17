import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { sampleTeam, sampleTrial, sampleTrialUsedUp } from './plan-billing-fixtures'
import { denyReasonCopy, statusLabel } from './plan-billing-copy'
import { planHealth } from './PlanStatusBadge'
import {
  accountMenuTrialRow,
  accountMenuUsageLines,
  trialHoursLeftHint,
  trialHoursUsedLine,
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
    expect(usageWarningLine(team({ usageWarningPercent: null }), t, 'en')).toBeNull()
    expect(usageWarningLine(team({ usageWarningPercent: 75 }), t, 'en')).toBe(
      'Your team has used 75% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usageWarningPercent: 90 }), t, 'en')).toBe(
      'Your team has used 90% of this month’s sandbox hours.'
    )
    expect(usageWarningLine(team({ usageWarningPercent: 80 }), t, 'en')).toBe(
      'Your team has used 80% of this month’s sandbox hours.'
    )
  })

  it('says what happens next at 100%, by overage', () => {
    const out = { usedSeconds: 120 * HOUR, remainingIncludedSeconds: 0, usageWarningPercent: 100 }
    expect(usageWarningLine(team(out), t, 'en')).toBe(
      'Your team has used all of this month’s sandbox hours. Running sandboxes go to sleep and new ones can’t start. Turn on overage to keep going.'
    )
    expect(
      usageWarningLine(
        team({ ...out, overage: { ...sampleTeam.overage, optedIn: true, spendCapCents: 2500 } }),
        t,
        'en'
      )
    ).toBe(
      'Your team has used all of this month’s sandbox hours. Overage is on, up to your $25 spend cap.'
    )
  })

  it('states the actual share used, floored, not the level that triggered it', () => {
    expect(
      usageWarningLine(team({ usedSeconds: 119 * HOUR, usageWarningPercent: 90 }), t, 'en')
    ).toBe('Your team has used 99% of this month’s sandbox hours.')
    expect(
      usageWarningLine(team({ usedSeconds: 92 * HOUR, usageWarningPercent: 75 }), t, 'en')
    ).toBe('Your team has used 76% of this month’s sandbox hours.')
    // Never "100%" while billing still reports hours left.
    expect(
      usageWarningLine(team({ usedSeconds: 119.9 * HOUR, usageWarningPercent: 90 }), t, 'en')
    ).toBe('Your team has used 99% of this month’s sandbox hours.')
  })

  it('shows the warning to owners and admins only: members are not alerted', () => {
    const member = team({
      usedSeconds: 110 * HOUR,
      usageWarningPercent: 90,
      canManageBilling: false
    })
    expect(usageWarningLine(member, t, 'en')).toBeNull()
    expect(accountMenuUsageLines({ status: 'ok', entitlement: member }, t, 'en')).toEqual({
      hoursLeft: '78.5 sandbox hours left',
      warning: null
    })
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
        t,
        'en'
      )
    ).toEqual({
      hoursLeft: '20 sandbox hours left',
      warning: 'Your team has used 90% of this month’s sandbox hours.'
    })
    expect(
      accountMenuUsageLines(
        { status: 'ok', entitlement: team({ plan: null, planLabel: null, status: 'none' }) },
        t,
        'en'
      )
    ).toBeNull()
    expect(accountMenuUsageLines({ status: 'failed', error: 'offline' }, t, 'en')).toBeNull()
  })
})

describe('trial copy (glossary "Trial")', () => {
  it('counts the one-time trial hours without "this month"', () => {
    expect(trialHoursUsedLine(sampleTrial, t)).toBe('0.6 of 2 sandbox hours used')
    expect(trialHoursLeftHint(sampleTrial, t)).toBe('Trial · 1.4 sandbox hours left')
    expect(trialHoursLeftHint({ ...sampleTrial, remainingIncludedSeconds: HOUR }, t)).toBe(
      'Trial · 1 sandbox hour left'
    )
  })

  it('shows the account menu row to every member, Choose plan to owners and admins only', () => {
    expect(accountMenuTrialRow({ status: 'ok', entitlement: sampleTrial }, t)).toEqual({
      label: 'Trial · 1.4 sandbox hours left',
      usedUp: false,
      canChoosePlan: true
    })
    expect(
      accountMenuTrialRow(
        { status: 'ok', entitlement: { ...sampleTrial, canManageBilling: false } },
        t
      )
    ).toMatchObject({ canChoosePlan: false })
    expect(accountMenuTrialRow({ status: 'ok', entitlement: sampleTrialUsedUp }, t)).toMatchObject({
      label: 'Your trial is used up',
      usedUp: true
    })
    // Gone once a plan starts, and never for a team without a trial.
    expect(accountMenuTrialRow({ status: 'ok', entitlement: sampleTeam }, t)).toBeNull()
    expect(accountMenuTrialRow({ status: 'failed', error: 'x' }, t)).toBeNull()
    // The plan's hours line stays off during a trial.
    expect(accountMenuUsageLines({ status: 'ok', entitlement: sampleTrial }, t, 'en-US')).toBeNull()
  })

  it('labels the trial "Trial" and says what to do when it is used up or unavailable', () => {
    expect(statusLabel('trial', t)).toBe('Trial')
    expect(planHealth(sampleTrial, t)).toEqual({ label: 'Trial', dot: null })
    expect(planHealth(sampleTrialUsedUp, t)).toEqual({ label: 'Trial', dot: 'warning' })
    expect(denyReasonCopy('trial_used_up', t, true)).toBe(
      'Your trial is used up. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Choose a plan to keep using Orca Cloud.'
    )
    expect(denyReasonCopy('trial_used_up', t, false)).toBe(
      'Your team’s trial is used up. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Ask an owner or admin to choose a plan.'
    )
    expect(denyReasonCopy('trial_unavailable', t, true)).toBe(
      'This account or team already used its trial. Choose a plan to use Orca Cloud.'
    )
    expect(denyReasonCopy('trial_unavailable', t, false)).toBe(
      'This account or team already used its trial. Ask an owner or admin to choose a plan.'
    )
  })
})
