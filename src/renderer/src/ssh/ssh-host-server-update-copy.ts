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
          'Runs a managed Orca server from a newer Orca; it keeps that version.'
        )
      }
    case 'deferred':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.updateDeferredLater',
          'Runs a managed Orca server; it updates on a later connect.'
        ),
        ...withDetail(update.detail)
      }
    case 'failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.updateFailedPrevious',
          'Runs a managed Orca server on its previous version; updating it failed.'
        ),
        ...withDetail(update.detail)
      }
    case 'rolled-back':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.behindRolledBack',
          'Runs an older managed Orca server than this app; the last update was rolled back. Use Update server to try again.'
        )
      }
    case 'no-template':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.behindNoTemplate',
          'Runs a managed Orca server this app can’t update; this build has no server for this host.'
        )
      }
    case 'migrating':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.behindMigrating',
          'Runs a managed Orca server that updates after its project move finishes.'
        )
      }
    case 'check-failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.behindCheckFailed',
          'Runs a managed Orca server; Orca couldn’t check whether it is behind this app.'
        ),
        ...withDetail(update.detail)
      }
  }
}

export function withDetail(detail: string | undefined): Pick<SshHostServerStatusLine, 'detail'> {
  return detail ? { detail } : {}
}
