// A wake, restart or unarchive the plan refused: the failure card says why in the same words as the
// create sheet's billing blocker, and offers the one fix that applies to someone who can make it
// (owner or admin). A member reads who to ask. Never the control plane's code.
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { describeError } from '@/components/cloud-workspaces/cloud-workspace-errors'
import {
  blockerCopy,
  type BillingBlockKind
} from '@/components/worktree-creation/VmBuildBillingBlocker'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { ORCA_BILLING_OVERAGE_SECTION_ID } from '@/components/new-workspace/orca-cloud-run-target-access'
import { classifyEntitlementDenial } from '../../../../shared/orca-billing'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudWakeBillingFix = 'seePlans' | 'raiseSpendCap' | 'updatePayment'
export type CloudWakeBillingCopy = { body: string; fix: CloudWakeBillingFix | null }

const BLOCK_KIND: Partial<Record<ReturnType<typeof classifyEntitlementDenial>, BillingBlockKind>> =
  { plan: 'plan', hours: 'hoursUsed', spendCap: 'spendCap', payment: 'payment' }

const FIX: Record<BillingBlockKind, CloudWakeBillingFix> = {
  plan: 'seePlans',
  hoursUsed: 'seePlans',
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
  const copy = blockerCopy(kind, t)
  // The sheet's payment line is about new sandboxes; this one already exists.
  const body =
    kind === 'payment'
      ? t('orcaCloudWorkspace.overlay.billingPayment', 'Your team’s last payment failed.')
      : copy.body
  return canManageBilling ? { body, fix: FIX[kind] } : { body: `${body} ${copy.ask}`, fix: null }
}

export function cloudWakeBillingFixLabel(fix: CloudWakeBillingFix, t: Translate): string {
  switch (fix) {
    case 'seePlans':
      return t('orcaCloudWorkspace.error.seePlans', 'See plans')
    case 'raiseSpendCap':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.raiseSpendCap',
        'Raise spend cap'
      )
    case 'updatePayment':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.updatePayment',
        'Update payment method'
      )
  }
}

export function runCloudWakeBillingFix(fix: CloudWakeBillingFix): void {
  if (fix === 'seePlans') {
    openPlansPage('sandbox')
    return
  }
  const store = useAppStore.getState()
  store.openSettingsTarget({
    pane: 'cloud-billing',
    repoId: null,
    // The spend cap lives on the overage card; the payment notice tops the section already.
    ...(fix === 'raiseSpendCap' ? { sectionId: ORCA_BILLING_OVERAGE_SECTION_ID } : {})
  })
  store.openSettingsPage()
}
