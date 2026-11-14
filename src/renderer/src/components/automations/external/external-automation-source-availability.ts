import type { ExternalAutomationManager } from '../../../../../shared/automations/external/external-automation'
import type { SshConnectionStatus } from '../../../../../shared/ssh-types'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function isSshConnectionBusy(status: SshConnectionStatus | undefined): boolean {
  return isConnectingSshStatus(status)
}

export function getExternalAutomationActionDisabledMessage(
  args: {
    manager: ExternalAutomationManager
    providerLabel?: string
    sshStatus?: SshConnectionStatus
    actionInProgress?: boolean
  },
  t: Translate = translate
): string | null {
  if (args.actionInProgress) {
    return t(
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
      return t(
        'auto.components.automations.externalActionDisabled.sshConnecting',
        'Wait for this SSH host to finish connecting.'
      )
    }
    if (args.manager.error && !isSshDisconnectedError(args.manager.error)) {
      return args.manager.error
    }
    if (args.sshStatus !== 'connected') {
      return t(
        'auto.components.automations.externalActionDisabled.connectSshHost',
        'Connect this SSH host before managing {{provider}} automations.',
        { provider }
      )
    }
    return (
      args.manager.error ??
      t(
        'auto.components.automations.externalActionDisabled.cannotManageOnSshHost',
        '{{provider}} cannot manage automations on this SSH host.',
        { provider }
      )
    )
  }
  return (
    args.manager.error ??
    t(
      'auto.components.automations.externalActionDisabled.cannotManageLocally',
      '{{provider}} cannot manage automations on this machine.',
      { provider }
    )
  )
}

function isSshDisconnectedError(message: string): boolean {
  return /ssh target is not connected/i.test(message)
}
