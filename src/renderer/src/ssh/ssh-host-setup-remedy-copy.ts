// Mirror main's SETUP_REMEDY_MESSAGES through the catalog.
import { translate } from '@/i18n/i18n'
import type { SshHostServerSetupRemedy } from '../../../shared/ssh-host-server-setup-remedy'

export function sshHostSetupRemedyText(remedy: SshHostServerSetupRemedy): string {
  switch (remedy) {
    case 'retry':
      return translate(
        'auto.components.settings.sshHostServer.setupRetry',
        'Orca couldn’t start its server on this host. Try connecting again.'
      )
    case 'recover':
      return translate(
        'auto.components.settings.sshHostServer.setupRecover',
        'An interrupted update or stop of Orca’s server on this host needs recovering before it can start. Use Recover in Settings > Orca on your SSH hosts, then connect again.'
      )
    case 'free-host-space':
      return translate(
        'auto.components.settings.sshHostServer.setupFreeHostSpace',
        'This host doesn’t have enough free disk space for Orca to keep a backup of its server data while starting it. Free up space on the host, then connect again.'
      )
    case 'stop-unmanaged-runtime':
      return translate(
        'auto.components.settings.sshHostServer.setupStopUnmanagedRuntime',
        'An Orca server this app didn’t start is still using this host’s Orca data. Stop it on the host, then connect again. This host’s Details, in Settings > SSH Hosts, names its process.'
      )
    case 'see-details':
      return translate(
        'auto.components.settings.sshHostServer.setupSeeDetails',
        'Orca couldn’t start its server on this host. The cause is in this host’s Details, in Settings > SSH Hosts.'
      )
  }
}
