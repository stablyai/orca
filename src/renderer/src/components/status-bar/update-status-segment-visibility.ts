import type { UpdateStatus } from '../../../../shared/types'

export function shouldShowUpdateStatusSegment(
  status: UpdateStatus,
  downloadIntentVersion: string | null
): boolean {
  const isUserInitiated = 'userInitiated' in status && Boolean(status.userInitiated)
  const isNudgeDriven = 'activeNudgeId' in status && Boolean(status.activeNudgeId)
  const matchesExplicitDownload =
    'version' in status &&
    downloadIntentVersion !== null &&
    status.version === downloadIntentVersion

  if (status.state === 'downloading') {
    return isUserInitiated || isNudgeDriven || matchesExplicitDownload
  }
  if (status.state === 'downloaded') {
    // Why: passive background downloads are quiet while in progress, but once
    // ready they need a persistent way back to the install UI.
    return true
  }
  if (status.state === 'error') {
    return isUserInitiated || isNudgeDriven || downloadIntentVersion !== null
  }
  return false
}
