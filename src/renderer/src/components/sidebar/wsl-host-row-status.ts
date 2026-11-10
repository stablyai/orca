import type { ExecutionHostHealth } from '../../../../shared/execution-host/execution-host-health'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

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

export function getWslHostStatusLabel(
  status: WslHostStatus | undefined,
  t: Translate = translate
): string | null {
  if (status?.removalPending) {
    return t('auto.components.sidebar.wslHostRowStatus.removalPending', 'Removal didn’t finish')
  }
  switch (status?.state) {
    case undefined:
    case 'ready':
    case 'closed':
      return null
    case 'connecting':
      return t('auto.components.sidebar.wslHostRowStatus.connecting', 'Starting')
    case 'reconnecting':
      return t('auto.components.sidebar.wslHostRowStatus.reconnecting', 'Reconnecting')
    case 'distro-stopped':
      return t('auto.components.sidebar.wslHostRowStatus.distroStopped', 'Distro stopped')
    case 'unverifiable':
      return t('auto.components.sidebar.wslHostRowStatus.unverifiable', 'Can’t verify')
    case 'idle':
      return t('auto.components.sidebar.wslHostRowStatus.idle', 'Idle')
    case 'failed':
      return t('auto.components.sidebar.wslHostRowStatus.failed', 'Failed to start')
  }
}

export function getWslHostRowDetail(
  status: WslHostStatus | undefined,
  t: Translate = translate
): string {
  const kind = t('auto.components.sidebar.wslHostRowStatus.kind', 'WSL distro')
  const label = getWslHostStatusLabel(status, t)
  return label ? `${kind} · ${label}` : kind
}

export function getWslHostsTurnedOffLabel(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.turnedOff',
    'WSL hosts are turned off in Settings → Experimental'
  )
}

export function getWslHostsTurnOnLabel(t: Translate = translate): string {
  return t('auto.components.terminal.pane.WslHostUnavailableBanner.turnOn', 'Turn on')
}

export function getWslHostRowTurnedOffDetail(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.turnedOffShort',
    'Turned off in Settings → Experimental'
  )
}

export function getWslHostsPausedLabel(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.paused',
    'WSL hosts are paused in this build. Your saved hosts and their projects keep working; adding hosts and moving projects onto them is paused.'
  )
}

export function getWslHostsPausedShortLabel(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.pausedShort',
    'Adding WSL distros is paused in this build.'
  )
}

/** Explain missing orcad templates in dialogs; without them WSL hosts cannot run. */
export function getWslHostServerFilesMissingLabel(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.serverFilesMissing',
    'This build of Orca can’t run WSL hosts (server files missing).'
  )
}

export function getWslHostRowServerFilesMissingDetail(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.wslHostRowStatus.serverFilesMissingShort',
    'This build can’t run WSL hosts'
  )
}
