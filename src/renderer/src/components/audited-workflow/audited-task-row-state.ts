// Pure derivations for rendering an audited task list row / state badge.
// Kept free of React so it's trivially unit-testable, per house convention
// (see components/automations/automation-run-view-state.ts for the pattern).
import type {
  AuditedTaskState,
  AuditedTaskStatusProjection
} from '../../../../shared/audited-workflow-types'

export type AuditedTaskBadgeTone = 'neutral' | 'progress' | 'blocked' | 'success'

const TERMINAL_SUCCESS_STATES: readonly AuditedTaskState[] = ['landed']
const BLOCKED_STATES: readonly AuditedTaskState[] = ['blocked']
const IDLE_STATES: readonly AuditedTaskState[] = ['selected', 'cancelled']

export function getAuditedTaskBadgeTone(state: AuditedTaskState): AuditedTaskBadgeTone {
  if (BLOCKED_STATES.includes(state)) {
    return 'blocked'
  }
  if (TERMINAL_SUCCESS_STATES.includes(state)) {
    return 'success'
  }
  if (IDLE_STATES.includes(state)) {
    return 'neutral'
  }
  return 'progress'
}

// Human-readable state labels. Kept as a closed switch (not a Record built
// from AUDITED_TASK_STATES) so a new state added to the union is a compile
// error here until a label is authored for it.
export function getAuditedTaskStateLabel(state: AuditedTaskState): string {
  switch (state) {
    case 'selected':
      return 'Selected'
    case 'triaging':
      return 'Triaging'
    case 'planning':
      return 'Planning'
    case 'awaiting_plan_review':
      return 'Awaiting Plan Review'
    case 'plan_fixes_requested':
      return 'Plan Fixes Requested'
    case 'ready_to_implement':
      return 'Ready to Implement'
    case 'implementing':
      return 'Implementing'
    case 'awaiting_code_audit':
      return 'Awaiting Code Audit'
    case 'code_fixes_requested':
      return 'Code Fixes Requested'
    case 'awaiting_human_approval':
      return 'Awaiting Approval'
    case 'committing':
      return 'Committing'
    case 'committed':
      return 'Committed'
    case 'landing':
      return 'Landing'
    case 'landed':
      return 'Landed'
    case 'blocked':
      return 'Blocked'
    case 'cancelled':
      return 'Cancelled'
  }
}

export function sortAuditedTasksByRecency(
  tasks: readonly AuditedTaskStatusProjection[]
): AuditedTaskStatusProjection[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
}
