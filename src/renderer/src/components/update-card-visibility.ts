import type { UpdateStatus } from '../../../shared/types'

export type UpdateCardVisibilityInput = {
  status: UpdateStatus
  cachedVersion: string | null
  dismissedVersion: string | null
  hasStartedDownload: boolean
  updateUserInitiatedCycle: boolean
  autoDismissed: boolean
  errorDismissed: boolean
  collapsed: boolean
}

export function shouldShowUpdateCard(input: UpdateCardVisibilityInput): boolean {
  const {
    status,
    cachedVersion,
    dismissedVersion,
    hasStartedDownload,
    updateUserInitiatedCycle,
    autoDismissed,
    errorDismissed,
    collapsed
  } = input
  const isUserInitiated = 'userInitiated' in status && status.userInitiated
  const shouldShowDetailedErrorCard =
    status.state === 'error' && (hasStartedDownload || cachedVersion !== null)

  // Why: background checks should not interrupt the user; manual checks get
  // transient feedback even when the result is "up to date" or failed.
  if (status.state === 'checking' && !isUserInitiated) {
    return false
  }
  if (status.state === 'not-available' && !isUserInitiated) {
    return false
  }
  if (status.state === 'not-available' && autoDismissed) {
    return false
  }
  if (status.state === 'idle') {
    return false
  }
  // Why: errors tied to a concrete update action need to be visible, but
  // background check failures should stay silent.
  if (status.state === 'error' && !shouldShowDetailedErrorCard && !isUserInitiated) {
    return false
  }
  // Why: version-based dismissal keeps error cards visible for action failures;
  // a separate gate lets the error card's own close button hide it.
  if (status.state === 'error' && errorDismissed) {
    return false
  }
  // Why: a user-initiated check should show its result even if the same version
  // was dismissed during an earlier passive reminder cycle.
  if (cachedVersion && dismissedVersion === cachedVersion && !updateUserInitiatedCycle) {
    if (status.state !== 'downloading' && status.state !== 'error') {
      return false
    }
  }
  if (
    collapsed &&
    (status.state === 'downloading' || status.state === 'downloaded' || status.state === 'error')
  ) {
    return false
  }
  return true
}
