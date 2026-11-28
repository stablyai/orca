import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WslHostDistro } from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { wslSetVersion2Command } from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-host-failure-copy'

export function wslDistroStateLabel(distro: WslHostDistro, t: Translate = translate): string {
  if (distro.version === 1) {
    return t('auto.components.sidebar.AddWslHostFormPanel.wsl1', 'WSL 1 · not supported')
  }
  if (distro.environmentId) {
    return t('auto.components.sidebar.AddWslHostFormPanel.added', 'Already a host')
  }
  if (distro.state === 'unverifiable') {
    return t('auto.components.sidebar.AddWslHostFormPanel.unverifiable', 'Unknown')
  }
  return distro.state === 'running'
    ? t('auto.components.sidebar.AddWslHostFormPanel.running', 'Running')
    : t('auto.components.sidebar.AddWslHostFormPanel.stopped', 'Stopped')
}

/** Why a WSL 1 row is disabled, with the command that converts it. */
export function wsl1DistroReason(name: string, t: Translate = translate): string {
  return t(
    'auto.components.sidebar.AddWslHostFormPanel.wsl1Reason',
    'WSL 1 can’t run an Orca host; convert with {{command}}',
    { command: wslSetVersion2Command(name) }
  )
}

/** A version the registry did not report may be WSL 2, so only a known WSL 1 is excluded. */
export function hasWsl2Distro(distros: readonly WslHostDistro[]): boolean {
  return distros.some((distro) => distro.version !== 1)
}

/** The dialog's Add is the user's explicit start for a stopped distro, or one WSL couldn't vouch for. */
export function wslHostAddRequest(distro: WslHostDistro): {
  distro: string
  startIfStopped: boolean
} {
  return { distro: distro.name, startIfStopped: distro.state !== 'running' }
}

export function canAddWslDistro(distro: WslHostDistro | undefined): boolean {
  return distro !== undefined && distro.version !== 1 && distro.environmentId === null
}
