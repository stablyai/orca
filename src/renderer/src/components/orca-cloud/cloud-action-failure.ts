// How a failed Orca Cloud lifecycle call (archive, unarchive, restart) is said: one mapping for
// toasts and inline notices (sign in again, the plan's reason, unreachable).
import { classifyEntitlementDenial } from '../../../../shared/orca-billing'
import { getBillingSummary } from '../billing/billing-summary-store'
import { describeError } from '../cloud-workspaces/cloud-workspace-errors'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openPlansDialog } from '@/components/billing/plans/plans-dialog-store'
import { signInAgainMessage } from '@/lib/orca-cloud/orca-sign-in-again'
import { signInAgainToastAction } from '@/lib/orca-cloud/orca-sign-in-again-action'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** Codes map to plain copy; raw control-plane messages never reach a toast. */
/** A failed lifecycle call in words, for a toast or an inline notice. */
export function describeCloudActionFailure(
  result: Extract<CloudWorkspaceResult<null>, { ok: false }>
): string {
  if (result.code === 'entitlement_denied') {
    return describeError('entitlement_denied', result.reason ?? undefined)
  }
  if (result.userMessage) {
    return result.userMessage
  }
  if (result.code === 'unauthorized') {
    return signInAgainMessage()
  }
  return result.code === 'unavailable'
    ? translate(
        'orcaCloudWorkspace.error.unavailable',
        'Orca Cloud isn’t reachable right now. Try again in a moment.'
      )
    : translate('orcaCloudWorkspace.error.generic', 'Something went wrong. Try again.')
}

export function failureToast(title: string, result: CloudWorkspaceResult<null>): void {
  if (result.ok) {
    return
  }
  if (result.code === 'entitlement_denied') {
    // The shared classifier: the actual reason (plan, hours, spend cap, payment, limits), and
    // "Compare plans" only where buying fixes it and only for people who can (owner or admin).
    const denial = classifyEntitlementDenial(result.reason)
    const canFixWithPlans =
      (denial === 'plan' || denial === 'hours') && getBillingSummary().canManageBilling
    toast.error(title, {
      description: describeError('entitlement_denied', result.reason ?? undefined),
      ...(canFixWithPlans
        ? {
            action: {
              label: translate('auto.components.billing.comparePlans', 'Compare plans'),
              onClick: () => openPlansDialog()
            }
          }
        : {})
    })
    return
  }
  if (result.userMessage) {
    toast.error(title, { description: result.userMessage })
    return
  }
  if (result.code === 'unauthorized') {
    toast.error(title, { description: signInAgainMessage(), action: signInAgainToastAction() })
    return
  }
  toast.error(title, {
    description:
      result.code === 'unavailable'
        ? translate(
            'orcaCloudWorkspace.error.unavailable',
            'Orca Cloud isn’t reachable right now. Try again in a moment.'
          )
        : translate('orcaCloudWorkspace.error.generic', 'Something went wrong. Try again.')
  })
}
