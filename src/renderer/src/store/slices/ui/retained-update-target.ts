import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'

export type RetainedUpdateTarget = {
  version: string
  source: UpdateStatus['source']
}

export function reconcileRetainedUpdateTarget(
  previous: RetainedUpdateTarget | null,
  status: UpdateStatus
): RetainedUpdateTarget | null {
  const version =
    status.state === 'downloaded' || (status.state === 'error' && status.retryAction === 'install')
      ? status.version
      : undefined
  if (!version) {
    return null
  }
  return previous?.version === version && previous.source === status.source
    ? previous
    : { version, source: status.source }
}
