import type {
  BrowserDownloadFinishedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../../../shared/browser-guest-events'
import type { BrowserLoadError } from '../../../../shared/types'

type LoadFailureMeta = {
  host: string | null
  isLocalhostLike: boolean
}

type BrowserLoadErrorLike = BrowserLoadError | null

function humanizePermission(permission: string): string {
  switch (permission) {
    case 'media':
      return 'camera or microphone access'
    case 'pointerLock':
      return 'pointer lock'
    default:
      return permission
  }
}

export function formatPermissionNotice(event: BrowserPermissionDeniedEvent): string {
  const target = event.origin === 'unknown' ? 'this page' : event.origin
  return `${target} asked for ${humanizePermission(event.permission)}, and Orca denied it.`
}

export function formatPopupNotice(event: BrowserPopupEvent): string {
  const target = event.origin === 'unknown' ? 'A site' : event.origin
  if (event.action === 'opened-in-orca') {
    return `${target} opened a new page in Orca.`
  }
  if (event.action === 'opened-external') {
    return `${target} opened a new window in your default browser.`
  }
  return `${target} tried to open a popup Orca does not support here.`
}

export function formatDownloadFinishedNotice(event: BrowserDownloadFinishedEvent): string {
  if (event.status === 'completed') {
    return event.savePath ? `Downloaded to ${event.savePath}.` : 'Download complete.'
  }
  if (event.status === 'failed') {
    return event.error ?? 'Download failed.'
  }
  return event.error ?? 'Download canceled.'
}

export function formatByteCount(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatLoadFailureDescription(
  loadError: BrowserLoadErrorLike,
  meta: LoadFailureMeta
): string {
  if (!loadError) {
    return 'The page did not respond.'
  }
  if (meta.isLocalhostLike) {
    return "We couldn't connect to your local server."
  }
  if (loadError.code === 0) {
    return loadError.description
  }
  return "We couldn't connect to this page."
}

export function formatLoadFailureRecoveryHint(meta: LoadFailureMeta): string | null {
  if (!meta.isLocalhostLike) {
    return null
  }
  return 'If this should be a local app, make sure the server is running and listening on the expected port.'
}
