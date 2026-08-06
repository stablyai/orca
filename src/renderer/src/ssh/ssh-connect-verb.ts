import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Why: the sidebar card, the terminal overlay, the host-header menu, and the status-bar row
// can all be on screen at once. One vocabulary here stops them describing the same click
// three different ways.
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
