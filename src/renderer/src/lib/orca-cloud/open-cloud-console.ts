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

/** `billingHint`: the plan and period picked in the plans dialog, for the billing page to preselect. */
export async function openCloudConsole(
  section: OrcaCloudConsoleSection,
  billingHint?: OrcaCloudConsoleBillingHint
): Promise<void> {
  // A double click mints one code, not two.
  if (opening === section) {
    return
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
    } else if (result.ticketError) {
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
  } catch {
    toast.error(
      translate('settings.cloudConsole.openFailed', 'Couldn’t open the browser. Try again.')
    )
  } finally {
    opening = null
  }
}
