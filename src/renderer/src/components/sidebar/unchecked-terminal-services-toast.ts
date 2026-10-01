import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'

// Why one id: a batch delete past the same silent version must not stack one note per workspace.
const UNCHECKED_TERMINAL_SERVICES_TOAST_ID = 'unchecked-terminal-services'

/** Non-blocking note that a delete went ahead past a terminal-service version that did not answer. */
export function showUncheckedTerminalServicesToast(
  result: RemoveWorktreeResult | undefined,
  /** Present only when the delete ran on this machine, whose Manage Sessions can list the version. */
  openManageSessions: (() => void) | undefined
): void {
  if (!result?.uncheckedTerminalServices?.length) {
    return
  }
  toast.info(
    translate(
      'auto.components.sidebar.UncheckedTerminalServicesToast.5b1e0c7d2a',
      'Workspace deleted. A version of the terminal service didn’t answer.'
    ),
    {
      id: UNCHECKED_TERMINAL_SERVICES_TOAST_ID,
      // Why per host: this machine's Manage Sessions never lists a paired host's terminal service.
      description: openManageSessions
        ? translate(
            'auto.components.sidebar.UncheckedTerminalServicesToast.9c4f6a3e18',
            'Any terminal it still runs for this workspace wasn’t checked. Manage Sessions lists it once it answers.'
          )
        : translate(
            'auto.components.sidebar.UncheckedTerminalServicesToast.1d7e4b9f03',
            'Any terminal it still runs for this workspace on the host that ran it wasn’t checked.'
          ),
      ...(openManageSessions
        ? {
            action: {
              label: translate(
                'auto.components.settings.TerminalTccAttributionNotice.openManageSessions',
                'Open Manage Sessions'
              ),
              onClick: openManageSessions
            }
          }
        : {})
    }
  )
}
