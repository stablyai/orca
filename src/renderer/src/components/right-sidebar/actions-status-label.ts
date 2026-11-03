import { translate } from '@/i18n/i18n'
/** Translate known GitHub statuses while retaining unfamiliar host statuses as visible text. */
export function actionsStatusLabel(status: string | null): string {
  if (status === null) {
    return translate('actions.statusUnknown', 'Unknown')
  }
  switch (status) {
    case 'queued':
      return translate('actions.statusQueued', 'Queued')
    case 'in_progress':
      return translate('actions.statusRunning', 'In progress')
    case 'waiting':
      return translate('actions.statusWaiting', 'Waiting')
    case 'requested':
      return translate('actions.statusRequested', 'Requested')
    case 'pending':
      return translate('actions.statusPending', 'Pending')
    case 'completed':
      return translate('actions.statusCompleted', 'Completed')
    case 'success':
      return translate('actions.statusSuccess', 'Success')
    case 'failure':
    case 'failed':
    case 'error':
      return translate('actions.statusFailure', 'Failure')
    case 'startup_failure':
      return translate('actions.statusStartupFailure', 'Startup failure')
    case 'cancelled':
      return translate('actions.statusCancelled', 'Cancelled')
    case 'timed_out':
      return translate('actions.statusTimedOut', 'Timed out')
    case 'action_required':
      return translate('actions.statusAction', 'Action required')
    case 'skipped':
      return translate('actions.statusSkipped', 'Skipped')
    case 'neutral':
      return translate('actions.statusNeutral', 'Neutral')
    case 'stale':
      return translate('actions.statusStale', 'Stale')
    default:
      return status ?? translate('actions.statusUnknown', 'Unknown')
  }
}
