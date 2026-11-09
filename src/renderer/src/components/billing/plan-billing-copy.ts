// User-facing copy for billing states, kept apart from the components that render it.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingDenyReason,
  OrcaBillingOpenResult,
  OrcaBillingOverageResult
} from '../../../../shared/orca-billing'

export function denyReasonCopy(reason: OrcaBillingDenyReason, t: Translate): string {
  switch (reason) {
    case 'no_subscription':
      return t('auto.components.billing.reasonNoPlan', 'Hosted sandboxes need a paid plan.')
    case 'subscription_inactive':
      return t(
        'auto.components.billing.reasonInactive',
        'Your plan is not active. Choose a plan to start sandboxes.'
      )
    case 'payment_past_due':
      return t(
        'auto.components.billing.reasonPastDue',
        'Your last payment failed. Update your payment method to start new sandboxes.'
      )
    case 'included_hours_exhausted':
      return t(
        'auto.components.billing.reasonExhaustedOptIn',
        'You have used all included hours this month. Turn on overage to keep starting sandboxes.'
      )
    case 'overage_cap_reached':
      return t(
        'auto.components.billing.reasonCapRaise',
        'You reached this month’s overage spend cap. An admin can raise it.'
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
      return t('auto.components.billing.statusPastDue', 'Payment due')
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
        'auto.components.billing.openForbidden',
        'Only an org owner or admin can manage billing.'
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
      return t('auto.components.billing.openSignedOut', 'Sign in to Orca again to manage billing.')
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
        'auto.components.billing.openForbidden',
        'Only an org owner or admin can manage billing.'
      )
    case 'signed-out':
      return t('auto.components.billing.openSignedOut', 'Sign in to Orca again to manage billing.')
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
  }
}
