// Run facts both the desktop and the phone page list automations by; each side words them.
import type { AutomationRun, AutomationRunStatus } from './automations/history/automation-run'

export type AutomationLastRunTone =
  | 'failed'
  | 'succeeded'
  | 'running'
  | 'skipped'
  | 'never'
  | 'unknown'

export function indexLatestAutomationRuns<
  Run extends Pick<AutomationRun, 'automationId' | 'createdAt'>
>(runs: readonly Run[]): ReadonlyMap<string, Run> {
  const latest = new Map<string, Run>()
  for (const run of runs) {
    const existing = latest.get(run.automationId)
    if (!existing || run.createdAt > existing.createdAt) {
      latest.set(run.automationId, run)
    }
  }
  return latest
}

export function getToneForAutomationRunStatus(status: AutomationRunStatus): AutomationLastRunTone {
  if (status === 'dispatch_failed') {
    return 'failed'
  }
  if (status === 'completed') {
    return 'succeeded'
  }
  if (status === 'pending' || status === 'dispatching' || status === 'dispatched') {
    return 'running'
  }
  if (status.startsWith('skipped')) {
    return 'skipped'
  }
  return 'unknown'
}
