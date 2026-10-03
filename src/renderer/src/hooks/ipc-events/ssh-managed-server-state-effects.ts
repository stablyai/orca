/** What a change in an SSH host's server means for the rest of the app. */
import { toast } from 'sonner'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

export function applySshManagedServerTransition(
  previous: SshConnectionState['managedServer'],
  next: SshConnectionState['managedServer']
): void {
  if (
    next?.kind === 'managed' &&
    (previous?.kind !== 'managed' || previous.environmentId !== next.environmentId)
  ) {
    // Why all hosts: a host that just converted brings a new server whose projects must load.
    void useAppStore.getState().fetchReposForAllHosts()
    return
  }
  if (
    next?.kind === 'relay' &&
    next.reason === 'refused' &&
    !(
      previous?.kind === 'relay' &&
      previous.reason === 'refused' &&
      previous.detail === next.detail
    )
  ) {
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refused',
        'This SSH host could not move to a managed Orca server: {{blocker}}',
        { blocker: next.detail ?? '' }
      )
    )
  }
}
