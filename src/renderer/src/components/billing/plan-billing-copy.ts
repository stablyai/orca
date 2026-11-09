// User-facing copy for billing states, kept apart from the components that render it.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingDenyReason,
  OrcaBillingOpenResult,
  OrcaBillingOverageResult
} from '../../../../shared/orca-billing'

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
            'auto.components.billing.reasonExhausted3',
            'Out of sandbox hours for this month. Turn on overage to keep starting sandboxes. Your files are safe.'
          )
        : t(
            'auto.components.billing.reasonExhaustedMember2',
            'Out of sandbox hours for this month. Ask an owner or admin to add hours. Your files are safe.'
          )
    case 'overage_cap_reached':
      return canManage
        ? t(
            'auto.components.billing.reasonCapAdmin2',
            'Spend cap reached. Raise the monthly spend cap to keep starting sandboxes. Your files are safe.'
          )
        : t(
            'auto.components.billing.reasonCapMember3',
            'Spend cap reached. Ask an owner or admin to raise the spend cap. Your files are safe.'
          )
  }
}

export function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'active':
      return t('auto.components.billing.statusActive', 'Active')
    case 'trialing':
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
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
  }
}

export function overageFailureCopy(result: OrcaBillingOverageResult, t: Translate): string | null {
  switch (result.status) {
    case 'ok':
      return null
    case 'cap-too-high':
      return t('auto.components.billing.capTooHigh', 'That spend cap is above the allowed maximum.')
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
