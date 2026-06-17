import type { AutomationRunStatus } from './automations-types'

/** A run status that will not change further — used to gate one-time
 *  post-dispatch work like usage collection. */
export function isFinalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'dispatch_failed' ||
    status === 'skipped_precheck' ||
    status === 'skipped_missed' ||
    status === 'skipped_unavailable' ||
    status === 'skipped_needs_interactive_auth'
  )
}
