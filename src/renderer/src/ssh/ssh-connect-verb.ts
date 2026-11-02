import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Share vocabulary across simultaneous sidebar, pane, host-menu and status-bar controls.
export function sshConnectVerb(status: SshConnectionStatus | null | undefined): string {
  switch (status) {
    case 'auth-failed':
      return translate('auto.ssh.sshConnectVerb.reconnect', 'Reconnect')
    case 'error':
    case 'reconnection-failed':
      return translate('auto.ssh.sshConnectVerb.retry', 'Retry')
    case null:
    case undefined:
    case 'connected':
    case 'connecting':
    case 'deploying-relay':
    case 'disconnected':
    case 'reconnecting':
      return translate('auto.ssh.sshConnectVerb.connect', 'Connect')
  }
}

export function sshConnectingLabel(): string {
  return translate('auto.ssh.sshConnectVerb.connecting', 'Connecting…')
}
