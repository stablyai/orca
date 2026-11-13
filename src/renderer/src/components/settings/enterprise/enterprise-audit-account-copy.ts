// Wording for the audit events the auth service and billing send: members and invites, the team
// itself, and the plan. (Workspace, key, secret and routine wording is in enterprise-audit-copy.)
import type { Translate } from '@/i18n/use-translate'

type Sentence = (t: Translate) => string
type Detail = Record<string, unknown>
/**
 * `named` takes the thing's name ({{name}}): a key, a secret, a teammate, a workspace.
 * `detailed` builds the sentence from what the event recorded (a plan, seat counts, an amount);
 * it returns null when the event does not carry enough, and the plain sentence is used.
 */
export type ActionCopy = {
  plain: Sentence
  named?: (t: Translate, name: string) => string
  detailed?: (t: Translate, detail: Detail, locale: string | undefined) => string | null
}

/** Billing sends plan ids ("team"); the log shows them as names ("Team"). */
function planName(detail: Detail, key = 'plan'): string | null {
  const id = detail[key]
  return typeof id === 'string' && id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : null
}

function intervalWord(detail: Detail, t: Translate): string | null {
  return detail.interval === 'month'
    ? t('settings.enterprise.audit.interval.month', 'monthly')
    : detail.interval === 'year'
      ? t('settings.enterprise.audit.interval.year', 'annual')
      : null
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export const ACCOUNT_AUDIT_ACTIONS: Record<string, ActionCopy> = {
  'member.invited': {
    plain: (t) => t('settings.enterprise.audit.action.memberInvite', 'Invited a teammate'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.memberInviteNamed', 'Invited {{name}}', { name })
  },
  'member.invite_revoked': {
    plain: (t) => t('settings.enterprise.audit.action.inviteRevoke', 'Canceled an invite'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.inviteRevokeNamed', 'Canceled the invite for {{name}}', {
        name
      })
  },
  'member.removed': {
    plain: (t) => t('settings.enterprise.audit.action.memberRemove', 'Removed a teammate'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.memberRemoveNamed', 'Removed {{name}} from the team', {
        name
      })
  },
  'member.left': {
    plain: (t) => t('settings.enterprise.audit.action.memberLeft', 'Left the team')
  },
  'member.role_changed': {
    plain: (t) => t('settings.enterprise.audit.action.roleChange', 'Changed a teammate’s role'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.roleChangeNamed', 'Changed the role of {{name}}', {
        name
      })
  },
  'member.role_synced': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.roleSync',
        'Updated a teammate’s API keys to match their role'
      )
  },
  'team.created': {
    plain: (t) => t('settings.enterprise.audit.action.teamCreate', 'Created the team')
  },
  'team.renamed': {
    plain: (t) => t('settings.enterprise.audit.action.teamRename', 'Renamed the team'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.teamRenameNamed', 'Renamed the team to “{{name}}”', {
        name
      })
  },
  'member.joined': {
    plain: (t) => t('settings.enterprise.audit.action.memberJoined', 'Joined the team')
  },
  'team.deleted': {
    plain: (t) => t('settings.enterprise.audit.action.teamDelete', 'Deleted the team')
  },
  // Billing. Stripe reports plan and seat changes, so those read without a subject (the person
  // column says Orca); overage and the spend cap are changed by a person in Plan & billing.
  'billing.plan_started': {
    plain: (t) => t('settings.enterprise.audit.action.planStarted', 'Plan started'),
    detailed: (t, detail) => {
      const plan = planName(detail)
      const interval = intervalWord(detail, t)
      return plan && interval
        ? t(
            'settings.enterprise.audit.action.planStartedDetail',
            'Plan started ({{plan}}, {{interval}})',
            { plan, interval }
          )
        : null
    }
  },
  'billing.plan_changed': {
    plain: (t) => t('settings.enterprise.audit.action.planChanged', 'Plan changed'),
    detailed: (t, detail) => {
      const plan = planName(detail)
      const interval = intervalWord(detail, t)
      return plan && interval
        ? t(
            'settings.enterprise.audit.action.planChangedDetail',
            'Plan changed to {{plan}}, {{interval}}',
            { plan, interval }
          )
        : null
    }
  },
  'billing.plan_canceled': {
    plain: (t) => t('settings.enterprise.audit.action.planCanceled', 'Plan ended')
  },
  'billing.cancel_scheduled': {
    plain: (t) =>
      t('settings.enterprise.audit.action.cancelScheduled', 'Plan set to end at the next renewal'),
    detailed: (t, detail, locale) => {
      const endsAt = count(detail.endsAt)
      return endsAt
        ? t('settings.enterprise.audit.action.cancelScheduledOn', 'Plan set to end on {{date}}', {
            date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(endsAt)
          })
        : null
    }
  },
  'billing.cancel_reverted': {
    plain: (t) => t('settings.enterprise.audit.action.cancelReverted', 'Plan set to renew again')
  },
  'billing.seats_changed': {
    plain: (t) => t('settings.enterprise.audit.action.seatsChanged', 'Seats changed'),
    detailed: (t, detail) => {
      const from = count(detail.previousSeats)
      const to = count(detail.seats)
      return from !== null && to !== null
        ? t(
            'settings.enterprise.audit.action.seatsChangedDetail',
            'Seats changed from {{from}} to {{to}}',
            { from: String(from), to: String(to) }
          )
        : null
    }
  },
  'billing.overage_enabled': {
    plain: (t) => t('settings.enterprise.audit.action.overageOn', 'Turned on overage')
  },
  'billing.overage_disabled': {
    plain: (t) => t('settings.enterprise.audit.action.overageOff', 'Turned off overage')
  },
  'billing.spend_cap_changed': {
    plain: (t) =>
      t('settings.enterprise.audit.action.spendCapChanged2', 'Changed the monthly spend cap'),
    detailed: (t, detail, locale) => {
      // No amount (null) means the plan's default cap: say only that it changed.
      const cents = count(detail.spendCapCents)
      return cents === null
        ? null
        : t(
            'settings.enterprise.audit.action.spendCapChangedTo',
            'Changed the monthly spend cap to {{amount}}',
            {
              amount: new Intl.NumberFormat(locale, {
                style: 'currency',
                currency: 'USD',
                minimumFractionDigits: cents % 100 === 0 ? 0 : 2
              }).format(cents / 100)
            }
          )
    }
  }
}
