// "Manage in browser": team, billing and admin settings live in the Orca Cloud web console.
// Main asks auth for a single-use login code and opens the page in the system browser; without a
// code the browser asks the person to sign in, so a failed request still opens the page.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { OrcaCloudConsoleSection } from '../../../../shared/orca-cloud-console'

let opening: OrcaCloudConsoleSection | null = null

export async function openCloudConsole(section: OrcaCloudConsoleSection): Promise<void> {
  // A double click mints one code, not two.
  if (opening === section) {
    return
  }
  opening = section
  try {
    const result = await window.api.orcaProfiles.openCloudConsole({ section })
    if (result.status !== 'opened') {
      toast.error(
        translate('settings.cloudConsole.openFailed', 'Couldn’t open the browser. Try again.')
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
