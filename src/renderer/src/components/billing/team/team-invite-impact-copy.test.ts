import { describe, expect, it } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import type { Translate } from '@/i18n/use-translate'
import { sampleTeam } from '../plan-billing-fixtures'
import { formatCents } from '../plans/plans-pricing'
import { inviteSeatImpactLine } from './team-invite-impact-copy'
import { inviteSeatImpact } from './team-seat-math'

const DAY = 86_400_000

// Mirrors i18next's `_one` plural pick so both forms are checked.
const t: Translate = (_key, fallback, options) => {
  const one = options?.count === 1 ? options.defaultValue_one : undefined
  const text = typeof one === 'string' ? one : fallback
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}

function team(overrides: Partial<OrcaBillingEntitlement> = {}): OrcaBillingEntitlement {
  return {
    ...sampleTeam,
    status: 'active',
    interval: 'month',
    seats: 3,
    seatChange: null,
    cancelAtPeriodEnd: false,
    period: { start: 0, end: 30 * DAY },
    ...overrides
  }
}

function line(
  entitlement: OrcaBillingEntitlement | null,
  counts: { members: number; pendingInvites: number; newInvites: number }
): string {
  const impact = inviteSeatImpact({ entitlement, ...counts, now: 0 })
  return inviteSeatImpactLine(impact, counts.newInvites, 'en-US', t)
}

const monthly = sampleTeam.offers?.team.monthlyPriceCentsPerSeat ?? 0

describe('invite seat impact line', () => {
  it('says how many seats are open before anything is typed', () => {
    expect(line(team({ seats: 5 }), { members: 2, pendingInvites: 1, newInvites: 0 })).toBe(
      'Each invite uses a seat once accepted. You have 2 open seats.'
    )
    expect(line(team({ seats: 3 }), { members: 3, pendingInvites: 0, newInvites: 0 })).toBe(
      'Each invite uses a seat once accepted. You have no open seats.'
    )
  })

  it('adds nothing while the invites fit in open seats', () => {
    expect(line(team({ seats: 4 }), { members: 3, pendingInvites: 0, newInvites: 1 })).toBe(
      'Each invite uses a seat once accepted. You have 1 open seat, so no seats will be added.'
    )
  })

  it('prices the added seats from billing, per period, prorated', () => {
    const total = formatCents(2 * monthly, 'en-US')
    expect(line(team({ seats: 3 }), { members: 3, pendingInvites: 0, newInvites: 2 })).toBe(
      `Each invite uses a seat once accepted. You have no open seats, so 2 more seats (${total}/mo, prorated) will be added.`
    )
  })

  it('counts open seats first, then pluralizes the added ones apart', () => {
    const one = formatCents(monthly, 'en-US')
    expect(line(team({ seats: 4 }), { members: 3, pendingInvites: 0, newInvites: 2 })).toBe(
      `Each invite uses a seat once accepted. You have 1 open seat, so 1 more seat (${one}/mo, prorated) will be added.`
    )
  })

  it('names the yearly price on annual plans', () => {
    expect(
      line(team({ seats: 1, interval: 'year' }), { members: 1, pendingInvites: 0, newInvites: 1 })
    ).toMatch(/\/yr, prorated\) will be added\.$/)
  })

  it('never shows a price billing did not send', () => {
    expect(
      line(team({ seats: 3, offers: null }), { members: 3, pendingInvites: 0, newInvites: 2 })
    ).toBe(
      'Each invite uses a seat once accepted. You have no open seats, so 2 more seats will be added, prorated.'
    )
  })

  it('keeps to the rule when billing is off or unreachable', () => {
    expect(line(null, { members: 3, pendingInvites: 0, newInvites: 2 })).toBe(
      'Each invite uses a seat once accepted.'
    )
  })

  it('says invites are free before the team has a plan', () => {
    expect(
      line(team({ plan: null, status: 'none' }), { members: 1, pendingInvites: 0, newInvites: 1 })
    ).toBe('Invites are free. Seats are billed once your team picks a plan.')
  })
})
