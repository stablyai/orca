import type { ExecutionHostHealth } from '../../../../shared/execution-host-health'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { translate } from '@/i18n/i18n'

/** The WSL liveness verdict decides health except once the server itself answered. */
export function getWslHostRowHealth(
  serverHealth: ExecutionHostHealth,
  status: WslHostStatus | undefined
): ExecutionHostHealth {
  switch (status?.state) {
    case undefined:
    case 'ready':
      return serverHealth
    case 'connecting':
    case 'reconnecting':
      return 'connecting'
    case 'failed':
    case 'unverifiable':
      return 'error'
    case 'distro-stopped':
    case 'idle':
    case 'closed':
      return 'disconnected'
  }
}

export function getWslHostStatusLabel(status: WslHostStatus | undefined): string | null {
  switch (status?.state) {
    case undefined:
    case 'ready':
    case 'closed':
      return null
    case 'connecting':
      return translate('auto.components.sidebar.wslHostRowStatus.connecting', 'Starting')
    case 'reconnecting':
      return translate('auto.components.sidebar.wslHostRowStatus.reconnecting', 'Reconnecting')
    case 'distro-stopped':
      return translate('auto.components.sidebar.wslHostRowStatus.distroStopped', 'Distro stopped')
    case 'unverifiable':
      return translate('auto.components.sidebar.wslHostRowStatus.unverifiable', 'Can’t verify')
    case 'idle':
      return translate('auto.components.sidebar.wslHostRowStatus.idle', 'Idle')
    case 'failed':
      return translate('auto.components.sidebar.wslHostRowStatus.failed', 'Failed to start')
  }
}

export function getWslHostRowDetail(status: WslHostStatus | undefined): string {
  const kind = translate('auto.components.sidebar.wslHostRowStatus.kind', 'WSL distro')
  const label = getWslHostStatusLabel(status)
  return label ? `${kind} · ${label}` : kind
}

export function getWslHostsTurnedOffLabel(): string {
  return translate(
    'auto.components.sidebar.wslHostRowStatus.turnedOff',
    'WSL hosts are turned off in Settings → Experimental'
  )
}

export function getWslHostsTurnOnLabel(): string {
  return translate('auto.components.terminal.pane.WslHostUnavailableBanner.turnOn', 'Turn on')
}

export function getWslHostRowTurnedOffDetail(): string {
  return translate(
    'auto.components.sidebar.wslHostRowStatus.turnedOffShort',
    'Turned off in Settings → Experimental'
  )
}

/** Explain missing orcad templates in dialogs; without them WSL hosts cannot run. */
export function getWslHostServerFilesMissingLabel(): string {
  return translate(
    'auto.components.sidebar.wslHostRowStatus.serverFilesMissing',
    'This build of Orca can’t run WSL hosts (server files missing).'
  )
}

export function getWslHostRowServerFilesMissingDetail(): string {
  return translate(
    'auto.components.sidebar.wslHostRowStatus.serverFilesMissingShort',
    'This build can’t run WSL hosts'
  )
}
