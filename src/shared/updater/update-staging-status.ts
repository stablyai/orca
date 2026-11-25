import type { UpdateStatus } from './update-status-types'

type MacStagingTimeoutStatus = Extract<UpdateStatus, { state: 'error' }> & {
  messageCode: 'macStagingTimeout'
}

/** macOS passed its staging guidance deadline but has not reported a result; main refuses checks, downloads and build switches until it does. */
export function isMacStagingStillRunning(status: UpdateStatus): status is MacStagingTimeoutStatus {
  return status.state === 'error' && status.messageCode === 'macStagingTimeout'
}
