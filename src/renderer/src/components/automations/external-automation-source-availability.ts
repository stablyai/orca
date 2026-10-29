import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { translate } from '@/i18n/i18n'

export function isSshConnectionBusy(status: SshConnectionStatus | undefined): boolean {
  return isConnectingSshStatus(status)
}

export function getExternalAutomationActionDisabledMessage(args: {
  manager: ExternalAutomationManager
  providerLabel?: string
  sshStatus?: SshConnectionStatus
  actionInProgress?: boolean
}): string | null {
  if (args.actionInProgress) {
    return translate(
      'auto.components.automations.externalActionDisabled.actionInProgress',
      'Another automation action is still running.'
    )
  }
  if (args.manager.canManage) {
    return null
  }
  const provider = args.providerLabel ?? 'OpenClaw'
  if (args.manager.target.type === 'ssh') {
    if (isSshConnectionBusy(args.sshStatus)) {
      return translate(
        'auto.components.automations.externalActionDisabled.sshConnecting',
        'Wait for this SSH host to finish connecting.'
      )
    }
    if (args.manager.error && !isSshDisconnectedError(args.manager.error)) {
      return args.manager.error
    }
    if (args.sshStatus !== 'connected') {
      return translate(
        'auto.components.automations.externalActionDisabled.connectSshHost',
        'Connect this SSH host before managing {{provider}} automations.',
        { provider }
      )
    }
    return (
      args.manager.error ??
      translate(
        'auto.components.automations.externalActionDisabled.cannotManageOnSshHost',
        '{{provider}} cannot manage automations on this SSH host.',
        { provider }
      )
    )
  }
  return (
    args.manager.error ??
    translate(
      'auto.components.automations.externalActionDisabled.cannotManageLocally',
      '{{provider}} cannot manage automations on this machine.',
      { provider }
    )
  )
}

function isSshDisconnectedError(message: string): boolean {
  return /ssh target is not connected/i.test(message)
}
