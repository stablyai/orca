import type {
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../../../shared/automations-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'

export function isSshConnectionBusy(status: SshConnectionStatus | undefined): boolean {
  return isConnectingSshStatus(status)
}

export function getExternalAutomationActionDisabledMessage(args: {
  manager: ExternalAutomationManager
  providerLabel?: string
  targetKindLabel?: string
  sshStatus?: SshConnectionStatus
  actionInProgress?: boolean
}): string | null {
  if (args.actionInProgress) {
    return 'Another automation action is still running.'
  }
  if (args.manager.canManage) {
    return null
  }
  const providerLabel = args.providerLabel ?? getProviderLabel(args.manager.provider)
  const targetKindLabel =
    args.targetKindLabel ?? (args.manager.target.type === 'ssh' ? 'SSH host' : 'Local')
  if (args.manager.target.type === 'ssh') {
    if (isSshConnectionBusy(args.sshStatus)) {
      return `Wait for this ${targetKindLabel.toLowerCase()} to finish connecting.`
    }
    if (args.manager.error && !isSshDisconnectedError(args.manager.error)) {
      return args.manager.error
    }
    if (args.sshStatus !== 'connected') {
      return `Connect this ${targetKindLabel.toLowerCase()} before managing ${providerLabel} automations.`
    }
    return (
      args.manager.error ??
      `${providerLabel} cannot manage automations on this ${targetKindLabel.toLowerCase()}.`
    )
  }
  return (
    args.manager.error ??
    `${providerLabel} cannot manage automations on this ${targetKindLabel.toLowerCase()}.`
  )
}

function getProviderLabel(provider: ExternalAutomationProvider): string {
  return provider === 'hermes' ? 'Hermes' : 'OpenClaw'
}

function isSshDisconnectedError(message: string): boolean {
  return /ssh target is not connected/i.test(message)
}
