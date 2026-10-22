/** Why a managed server kept its version on a connect: every state but host-newer may be behind. */
import type { SshManagedServerUpdateNote } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import type { SshHostServerStatusLine } from './ssh-host-server-status-copy'

export function managedUpdateLine(update: SshManagedServerUpdateNote): SshHostServerStatusLine {
  switch (update.state) {
    case 'host-newer':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.hostNewer',
          'Runs a newer version of Orca’s server than this app; it keeps that version.'
        )
      }
    case 'deferred':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.updateDeferredLater',
          'Runs Orca’s server; it updates on a later connect.'
        ),
        ...withDetail(update.detail)
      }
    case 'failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.updateFailedPrevious',
          'Runs Orca’s server on its previous version; updating it failed.'
        ),
        ...withDetail(update.detail)
      }
    case 'rolled-back':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.behindRolledBack',
          'Runs an older version of Orca’s server than this app; the last update was rolled back. Use Update server to try again.'
        )
      }
    case 'no-template':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.behindNoTemplate',
          'Runs a version of Orca’s server this app can’t update; this build has no server for this host.'
        )
      }
    case 'migrating':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.behindMigrating',
          'Runs Orca’s server, which updates after its project move finishes.'
        )
      }
    case 'check-failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.behindCheckFailed',
          'Runs Orca’s server; Orca couldn’t check whether it is behind this app.'
        ),
        ...withDetail(update.detail)
      }
  }
}

export function withDetail(detail: string | undefined): Pick<SshHostServerStatusLine, 'detail'> {
  return detail ? { detail } : {}
}
