export type ActionsStatusTone = 'success' | 'failure' | 'running' | 'waiting' | 'neutral'

/** Map known GitHub states to semantic color roles and keep unfamiliar states neutral. */
export function actionsStatusTone(status: string | null | undefined): ActionsStatusTone {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
    case 'failed':
    case 'timed_out':
    case 'startup_failure':
    case 'error':
      return 'failure'
    case 'in_progress':
      return 'running'
    case 'queued':
    case 'waiting':
    case 'requested':
    case 'pending':
    case 'action_required':
      return 'waiting'
    case null:
    case undefined:
    default:
      return 'neutral'
  }
}

export const ACTIONS_STATUS_TEXT_CLASSES: Record<ActionsStatusTone, string> = {
  success: 'text-status-success',
  failure: 'text-destructive',
  running: 'text-status-info',
  waiting: 'text-status-warning-foreground',
  neutral: 'text-muted-foreground'
}
