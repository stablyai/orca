import type {
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../../../shared/automations-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export type ExternalAutomationSourceAvailability = {
  statusLabel: string
  summary: string
  detail: string
  canConnectSsh: boolean
  isConnecting: boolean
}

type ExternalAutomationSourceAvailabilityArgs = {
  manager: ExternalAutomationManager
  providerLabel: string
  targetKindLabel: string
  sshStatus?: SshConnectionStatus
  isConnectingOverride?: boolean
}

export function getExternalAutomationSourceAvailability({
  manager,
  providerLabel,
  targetKindLabel,
  sshStatus,
  isConnectingOverride = false
}: ExternalAutomationSourceAvailabilityArgs): ExternalAutomationSourceAvailability {
  if (manager.target.type === 'ssh') {
    const isConnecting = isConnectingOverride || isSshConnectionBusy(sshStatus)
    if (isConnecting) {
      return {
        statusLabel: 'Connecting...',
        summary:
          manager.error ??
          `${providerLabel} source unavailable while ${targetKindLabel.toLowerCase()} connects.`,
        detail: 'Waiting for this SSH host before checking the remote automation source.',
        canConnectSsh: true,
        isConnecting: true
      }
    }

    if (sshStatus === 'connected') {
      return {
        statusLabel: 'Source unavailable',
        summary:
          manager.error ??
          `${providerLabel} source unavailable on this ${targetKindLabel.toLowerCase()}.`,
        detail: 'Install or repair the remote automation source, then retry to load jobs.',
        canConnectSsh: true,
        isConnecting: false
      }
    }

    return {
      statusLabel: 'Connect SSH',
      summary:
        manager.error ??
        `${providerLabel} source unavailable until ${targetKindLabel.toLowerCase()} connects.`,
      detail: 'Connect this SSH host to check for remote automation jobs.',
      canConnectSsh: true,
      isConnecting: false
    }
  }

  return {
    statusLabel: 'Source unavailable',
    summary:
      manager.error ?? `${providerLabel} source unavailable on ${targetKindLabel.toLowerCase()}.`,
    detail: 'Install or repair the local automation source, then retry to load jobs.',
    canConnectSsh: false,
    isConnecting: false
  }
}

export function isSshConnectionBusy(status: SshConnectionStatus | undefined): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
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
