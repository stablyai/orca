// A wake, restart or unarchive the plan refused: the failure card says why in the same words as the
// create sheet's billing blocker, and offers the one fix that applies to someone who can make it
// (owner or admin). A member reads who to ask. Never the control plane's code.
import type { Translate } from '@/i18n/use-translate'
import { describeError } from '@/components/cloud-workspaces/cloud-workspace-errors'
import {
  blockerCopy,
  type BillingBlockKind
} from '@/components/worktree-creation/VmBuildBillingBlocker'
import { classifyEntitlementDenial } from '../../../../shared/orca-billing'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudWakeBillingFix =
  | 'comparePlans'
  | 'turnOnOverage'
  | 'raiseSpendCap'
  | 'updatePayment'
export type CloudWakeBillingCopy = { body: string; fix: CloudWakeBillingFix | null }

const BLOCK_KIND: Partial<Record<ReturnType<typeof classifyEntitlementDenial>, BillingBlockKind>> =
  { plan: 'plan', hours: 'hoursUsed', spendCap: 'spendCap', payment: 'payment' }

const FIX: Record<BillingBlockKind, CloudWakeBillingFix> = {
  plan: 'comparePlans',
  // One click fixes it here, as on the create sheet: overage on at billing's default cap, then wake.
  hoursUsed: 'turnOnOverage',
  spendCap: 'raiseSpendCap',
  payment: 'updatePayment'
}

export function cloudWakeBillingCopy(
  wake: CloudWakeProgressEvent,
  canManageBilling: boolean,
  t: Translate
): CloudWakeBillingCopy | null {
  if (wake.phase !== 'failed' || !wake.billingDenial) {
    return null
  }
  const reason = wake.billingDenial.reason ?? undefined
  const kind = BLOCK_KIND[classifyEntitlementDenial(reason)]
  if (!kind) {
    // Running limits and anything unknown: the shared workspace copy (it says what to do).
    return { body: describeError('entitlement_denied', reason, t), fix: null }
  }
  const copy = blockerCopy(kind, t, reason, canManageBilling)
  // The sheet's payment line is about new sandboxes; this one already exists.
  const body =
    kind === 'payment'
      ? t('orcaCloudWorkspace.overlay.billingPayment', 'Your team’s last payment failed.')
      : copy.body
  return canManageBilling ? { body, fix: FIX[kind] } : { body: `${body} ${copy.ask}`, fix: null }
}
