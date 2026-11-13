// "Copy link" for the Stripe buttons: mints the same Checkout/Portal URL the button opens, without
// opening it. A refusal (signed out, not an admin, no billing account…) is said in a toast with the
// open path's own copy, then null, so the split button adds nothing of its own.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingLinkResult
} from '../../../../shared/orca-billing'
import { openFailureCopy } from './plan-billing-copy'

async function linkOrToast(mint: () => Promise<OrcaBillingLinkResult>): Promise<string | null> {
  const result = await mint().catch((error: unknown): OrcaBillingLinkResult => ({
    status: 'failed',
    error: String(error)
  }))
  if (result.status === 'ok') {
    return result.url
  }
  const failure = openFailureCopy(result, translate)
  if (failure) {
    toast.error(failure)
  }
  return null
}

/** The Customer Portal URL "Manage billing" / "Update payment method" would open. */
export function billingPortalLink(): Promise<string | null> {
  return linkOrToast(() => window.api.orcaProfiles.billingPortalLink())
}

/** The Checkout URL a plan's buy button would open for these args. */
export function billingCheckoutLink(args: OrcaBillingCheckoutArgs): Promise<string | null> {
  return linkOrToast(() => window.api.orcaProfiles.billingCheckoutLink(args))
}
