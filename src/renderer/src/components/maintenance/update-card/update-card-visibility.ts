// @protected-copy scope=file
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'

export function isUpdateCardVisible({
  status,
  dismissedVersion,
  cachedVersion,
  updateUserInitiatedCycle,
  autoDismissed = false,
  collapsed = false
}: {
  status: UpdateStatus
  dismissedVersion: string | null
  cachedVersion: string | null
  updateUserInitiatedCycle: boolean
  autoDismissed?: boolean
  collapsed?: boolean
}): boolean {
  const isUserInitiated = 'userInitiated' in status && Boolean(status.userInitiated)

  if (status.state === 'checking' && !isUserInitiated) {
    return false
  }
  if (status.state === 'not-available' && (!isUserInitiated || autoDismissed)) {
    return false
  }
  if (status.state === 'idle' || (status.state === 'available' && status.automaticDownload)) {
    return false
  }
  if (cachedVersion && dismissedVersion === cachedVersion && !updateUserInitiatedCycle) {
    if (status.state === 'available') {
      return false
    }
  }
  return !(
    collapsed &&
    (status.state === 'downloading' || status.state === 'downloaded' || status.state === 'error')
  )
}

export function getUpdateCardAriaLabel(status: UpdateStatus, t: Translate = translate): string {
  switch (status.state) {
    case 'idle':
      return t('auto.components.UpdateCard.aria.statusIdle', 'Update status')
    case 'checking':
      return t('auto.components.UpdateCard.aria.statusChecking', 'Checking for updates')
    case 'not-available':
      return t('auto.components.UpdateCard.aria.statusLatest', "You're on the latest version")
    case 'available':
      return t('auto.components.UpdateCard.aria.statusAvailable', 'Update available')
    case 'downloading':
      return t('auto.components.UpdateCard.aria.statusDownloading', 'Downloading update')
    case 'downloaded':
      return t('auto.components.UpdateCard.aria.statusDownloaded', 'Update ready to install')
    case 'error':
      if (status.installOnQuit) {
        return t('updates.installOnQuit.title', 'Update ready to install')
      }
      return status.installBlock
        ? t('updates.installBlock.waitingLabel', 'Update waiting')
        : t('auto.components.UpdateCard.aria.statusError', 'Update error')
  }
}

export function isHttp2ProtocolError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('err_http2_protocol_error') ||
    normalized.includes('http2_protocol_error') ||
    (normalized.includes('http/2') && normalized.includes('protocol'))
  )
}
