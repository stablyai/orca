import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

const SSH_STATUS_LABELS: Partial<Record<SshConnectionStatus, string>> = {
  get disconnected() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshNotConnected',
      'SSH not connected'
    )
  },
  get connecting() {
    return translate('auto.components.NewWorkspaceComposerCard.connectingSsh', 'Connecting SSH...')
  },
  get 'auth-failed'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshAuthenticationFailed',
      'SSH authentication failed'
    )
  },
  get 'deploying-relay'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.preparingSshConnection',
      'Preparing SSH connection...'
    )
  },
  get connected() {
    return translate('auto.components.NewWorkspaceComposerCard.connected', 'Connected')
  },
  get reconnecting() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.reconnectingSsh',
      'Reconnecting SSH...'
    )
  },
  get 'reconnection-failed'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshReconnectionFailed',
      'SSH reconnection failed'
    )
  },
  get error() {
    return translate('auto.components.NewWorkspaceComposerCard.a239038146', 'SSH connection error')
  }
}

export function getSshStatusLabel(status: SshConnectionStatus): string {
  return SSH_STATUS_LABELS[status] ?? status
}
