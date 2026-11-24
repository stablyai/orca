import type { UpdateStatus } from './update-status-types'

/** macOS passed its staging guidance deadline but has not reported a result; main refuses checks, downloads and build switches until it does. */
export function isMacStagingStillRunning(status: UpdateStatus): boolean {
  return status.state === 'error' && status.messageCode === 'macStagingTimeout'
}
