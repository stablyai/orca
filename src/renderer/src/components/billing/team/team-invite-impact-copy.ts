// The one line under "Invite teammates" that says what the invites do to seats. Billing's own
// numbers only (ENTITLEMENTS-C): no price is shown when billing didn't send one.
import type { Translate } from '@/i18n/use-translate'
import { formatCents } from '../plans/plans-pricing'
import type { InviteSeatImpact } from './team-seat-math'

/** "You have N open seats", its own key so the seat count and the added count pluralize apart. */
function openSeatsClause(open: number, t: Translate): string {
  return open === 0
    ? t('auto.components.billing.team.openSeatsNone', 'You have no open seats')
    : t('auto.components.billing.team.openSeatsClause', 'You have {{count}} open seats', {
        count: open,
        defaultValue_one: 'You have {{count}} open seat'
      })
}

export function inviteSeatImpactLine(
  impact: InviteSeatImpact,
  invites: number,
  locale: string,
  t: Translate
): string {
  switch (impact.kind) {
    case 'unknown':
      return t(
        'auto.components.billing.team.inviteSeatUnknown',
        'Each invite uses a seat once accepted.'
      )
    case 'no-plan':
      return t(
        'auto.components.billing.team.inviteNoPlan',
        'Invites are free. Seats are billed once your team picks a plan.'
      )
    case 'covered':
      return invites === 0
        ? t(
            'auto.components.billing.team.inviteSeatOpen',
            'Each invite uses a seat once accepted. {{openSeats}}.',
            {
              openSeats: openSeatsClause(impact.freeSeats, t)
            }
          )
        : t(
            'auto.components.billing.team.inviteSeatCovered',
            'Each invite uses a seat once accepted. {{openSeats}}, so no seats will be added.',
            { openSeats: openSeatsClause(impact.freeSeats, t) }
          )
    case 'adds-seats-unpriced':
      return t(
        'auto.components.billing.team.inviteSeatAddsUnpriced',
        'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seats will be added, prorated.',
        {
          openSeats: openSeatsClause(impact.freeSeats, t),
          count: impact.addedSeats,
          defaultValue_one:
            'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seat will be added, prorated.'
        }
      )
    case 'adds-seats': {
      const price = formatCents(impact.addedSeats * impact.perSeatPeriodCents, locale)
      return impact.interval === 'year'
        ? t(
            'auto.components.billing.team.inviteSeatAddsYear',
            'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seats ({{price}}/yr, prorated) will be added.',
            {
              openSeats: openSeatsClause(impact.freeSeats, t),
              count: impact.addedSeats,
              price,
              defaultValue_one:
                'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seat ({{price}}/yr, prorated) will be added.'
            }
          )
        : t(
            'auto.components.billing.team.inviteSeatAddsMonth',
            'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seats ({{price}}/mo, prorated) will be added.',
            {
              openSeats: openSeatsClause(impact.freeSeats, t),
              count: impact.addedSeats,
              price,
              defaultValue_one:
                'Each invite uses a seat once accepted. {{openSeats}}, so {{count}} more seat ({{price}}/mo, prorated) will be added.'
            }
          )
    }
  }
}
