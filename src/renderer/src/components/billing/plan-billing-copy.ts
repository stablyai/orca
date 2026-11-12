// User-facing copy for billing states, kept apart from the components that render it.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingDenyReason,
  OrcaBillingOpenResult,
  OrcaBillingOverageResult
} from '../../../../shared/orca-billing'
import { formatCents } from './plans/plans-pricing'

export function denyReasonCopy(
  reason: OrcaBillingDenyReason,
  t: Translate,
  canManage = true
): string {
  switch (reason) {
    case 'no_subscription':
      return t('auto.components.billing.reasonNoPlan2', 'Orca Cloud needs a Team plan.')
    case 'subscription_inactive':
      return canManage
        ? t(
            'auto.components.billing.reasonInactive',
            'Your plan is not active. Choose a plan to start sandboxes.'
          )
        : t(
            'auto.components.billing.reasonInactiveMember',
            'Your team’s plan is not active. Ask an owner or admin to choose a plan.'
          )
    case 'payment_grace_expired':
      return canManage
        ? t(
            'auto.components.billing.reasonGraceExpired3',
            'Payment failed. New sandboxes can’t start and running sandboxes are asleep. Update your payment method. Your files are safe.'
          )
        : t(
            'auto.components.billing.reasonGraceExpiredMember2',
            'Payment failed. New sandboxes can’t start and running sandboxes are asleep. Ask an owner or admin to update the payment method. Your files are safe.'
          )
    case 'payment_past_due':
      return canManage
        ? t(
            'auto.components.billing.reasonPastDue',
            'Your last payment failed. Update your payment method to start new sandboxes.'
          )
        : t(
            'auto.components.billing.reasonPastDueMember',
            'Your team’s last payment failed. Ask an owner or admin to update the payment method.'
          )
    case 'included_hours_exhausted':
      return canManage
        ? t(
            'auto.components.billing.reasonExhausted4',
            'Out of sandbox hours for this month. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Turn on overage to start sandboxes again.'
          )
        : t(
            'auto.components.billing.reasonExhaustedMember3',
            'Out of sandbox hours for this month. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Ask an owner or admin to add hours.'
          )
    case 'overage_cap_reached':
      return canManage
        ? t(
            'auto.components.billing.reasonCapAdmin3',
            'Spend cap reached. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Raise the monthly spend cap to start sandboxes again.'
          )
        : t(
            'auto.components.billing.reasonCapMember4',
            'Spend cap reached. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Ask an owner or admin to raise the spend cap.'
          )
    case 'trial_used_up':
      return canManage
        ? t(
            'auto.components.billing.reasonTrialUsedUp2',
            'Your trial is used up. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Choose a plan to keep using Orca Cloud.'
          )
        : t(
            'auto.components.billing.reasonTrialUsedUpMember2',
            'Your team’s trial is used up. Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe. Ask an owner or admin to choose a plan.'
          )
    case 'trial_unavailable':
      return canManage
        ? t(
            'auto.components.billing.reasonTrialUnavailable',
            'This account or team already used its trial. Choose a plan to use Orca Cloud.'
          )
        : t(
            'auto.components.billing.reasonTrialUnavailableMember',
            'This account or team already used its trial. Ask an owner or admin to choose a plan.'
          )
  }
}

export function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'active':
      return t('auto.components.billing.statusActive', 'Active')
    case 'trialing':
    case 'trial':
      return t('auto.components.billing.statusTrial', 'Trial')
    case 'past_due':
      return t('auto.components.billing.paymentFailed', 'Payment failed')
    case 'canceled':
      return t('auto.components.billing.statusCanceled', 'Canceled')
    default:
      return t('auto.components.billing.statusInactive', 'Inactive')
  }
}

export function openFailureCopy(result: OrcaBillingOpenResult, t: Translate): string | null {
  switch (result.status) {
    case 'opened':
      return null
    case 'forbidden':
      return t(
        'auto.components.billing.openForbidden2',
        'Only an owner or admin can manage billing.'
      )
    case 'already-subscribed':
      return t(
        'auto.components.billing.openAlreadySubscribed',
        'This account already has a plan. Use Manage billing to change it.'
      )
    case 'team-required':
      return t(
        'auto.components.billing.openTeamRequired',
        'Plans belong to a team. Create a team, then choose a plan.'
      )
    case 'no-billing-account':
      return t(
        'auto.components.billing.openNoAccount',
        'There is no billing account yet. Choose a plan first.'
      )
    case 'signed-out':
      return t(
        'auto.components.billing.openSignedOut2',
        'Sign in to Orca again to manage your team.'
      )
    case 'plan-unavailable':
      return t(
        'auto.components.billing.openPlanUnavailable',
        'Checkout for this plan isn’t working right now. Try again in a few minutes, or contact us and we’ll set you up.'
      )
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
  }
}

/** "The spend cap can be at most $5,000." */
export function capTooHighCopy(maxCents: number, locale: string, t: Translate): string {
  return t('auto.components.billing.capAtMost', 'The spend cap can be at most {{max}}.', {
    max: formatCents(maxCents, locale)
  })
}

export function overageFailureCopy(
  result: OrcaBillingOverageResult,
  t: Translate,
  /** The service's highest allowed cap; null from older services that don't send it. */
  maxCapCents: number | null = null,
  locale = 'en-US'
): string | null {
  switch (result.status) {
    case 'ok':
      return null
    case 'cap-too-high':
      return maxCapCents === null
        ? t('auto.components.billing.capTooHigh', 'That spend cap is above the allowed maximum.')
        : capTooHighCopy(maxCapCents, locale, t)
    case 'no-subscription':
      return t('auto.components.billing.overageNoPlan', 'Overage needs an active plan.')
    case 'forbidden':
      return t(
        'auto.components.billing.openForbidden2',
        'Only an owner or admin can manage billing.'
      )
    case 'signed-out':
      return t(
        'auto.components.billing.openSignedOut2',
        'Sign in to Orca again to manage your team.'
      )
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
  }
}
