import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Share vocabulary across simultaneous sidebar, pane, host-menu and status-bar controls.
export function sshConnectVerb(
  status: SshConnectionStatus | null | undefined,
  t: Translate = translate
): string {
  switch (status) {
    case 'auth-failed':
      return t('auto.ssh.sshConnectVerb.reconnect', 'Reconnect')
    case 'error':
    case 'reconnection-failed':
      return t('auto.ssh.sshConnectVerb.retry', 'Retry')
    case null:
    case undefined:
    case 'connected':
    case 'connecting':
    case 'deploying-relay':
    case 'disconnected':
    case 'reconnecting':
      return t('auto.ssh.sshConnectVerb.connect', 'Connect')
  }
}

export function sshConnectingLabel(t: Translate = translate): string {
  return t('auto.ssh.sshConnectVerb.connecting', 'Connecting…')
}
