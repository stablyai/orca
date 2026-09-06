import type { UpdateStatus } from '../../../../../shared/update-status-types'

export function isUpdateCardVisible({
  status,
  dismissedVersion,
  cachedVersion,
  hasStartedDownload,
  updateUserInitiatedCycle,
  autoDismissed = false,
  collapsed = false
}: {
  status: UpdateStatus
  dismissedVersion: string | null
  cachedVersion: string | null
  hasStartedDownload: boolean
  updateUserInitiatedCycle: boolean
  autoDismissed?: boolean
  collapsed?: boolean
}): boolean {
  const isUserInitiated = 'userInitiated' in status && Boolean(status.userInitiated)
  const shouldShowDetailedErrorCard =
    status.state === 'error' &&
    (hasStartedDownload ||
      cachedVersion !== null ||
      status.version !== undefined ||
      status.recovery?.kind === 'linux-package-install')

  if (status.state === 'checking' && !isUserInitiated) {
    return false
  }
  if (status.state === 'not-available' && (!isUserInitiated || autoDismissed)) {
    return false
  }
  if (status.state === 'idle') {
    return false
  }
  if (status.state === 'error' && !shouldShowDetailedErrorCard && !isUserInitiated) {
    return false
  }
  if (cachedVersion && dismissedVersion === cachedVersion && !updateUserInitiatedCycle) {
    if (status.state !== 'downloading' && status.state !== 'error') {
      return false
    }
  }
  return !(
    collapsed &&
    (status.state === 'downloading' || status.state === 'downloaded' || status.state === 'error')
  )
}

export function getUpdateCardAriaLabel(status: UpdateStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Update status'
    case 'checking':
      return 'Checking for updates'
    case 'not-available':
      return "You're on the latest version"
    case 'available':
      return 'Update available'
    case 'downloading':
      return 'Downloading update'
    case 'downloaded':
      return 'Update ready to install'
    case 'error':
      return 'Update error'
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
