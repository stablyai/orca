// "Manage in browser": team, billing and admin settings live in the Orca Cloud web console.
// Main asks auth for a single-use login code and opens the page in the system browser; without a
// code the browser asks the person to sign in, so a failed request still opens the page.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  OrcaCloudConsoleBillingHint,
  OrcaCloudConsoleSection
} from '../../../../shared/orca-cloud-console'

let opening: OrcaCloudConsoleSection | null = null

/**
 * `billingHint`: the plan and period picked in the plans dialog, for the billing page to preselect.
 * Resolves true once the browser opened (signed in or not), false when it didn't (or a click
 * already in flight is opening it).
 */
export async function openCloudConsole(
  section: OrcaCloudConsoleSection,
  billingHint?: OrcaCloudConsoleBillingHint
): Promise<boolean> {
  // A double click mints one code, not two.
  if (opening === section) {
    return false
  }
  opening = section
  try {
    const result = await window.api.orcaProfiles.openCloudConsole(
      billingHint ? { section, billingHint } : { section }
    )
    if (result.status !== 'opened') {
      toast.error(
        translate('settings.cloudConsole.openFailed', 'Couldn’t open the browser. Try again.')
      )
      return false
    }
    if (result.ticketError) {
      // The page opened, but not signed in: say why the browser asks for a sign-in.
      toast.warning(
        translate('settings.cloudConsole.signInFailed', 'Couldn’t sign you in to the console'),
        {
          description: translate(
            'settings.cloudConsole.signInFailedDetail',
            'Your browser opened it anyway. Sign in there to continue.'
          )
        }
      )
    }
    return true
  } catch {
    toast.error(
      translate('settings.cloudConsole.openFailed', 'Couldn’t open the browser. Try again.')
    )
    return false
  } finally {
    opening = null
  }
}
