import type { PRCheckJob, PRCheckStep } from '../../../../shared/types'

export type StepOutcome = 'success' | 'failure' | 'skipped' | 'pending'

export function resolveStepOutcome(step: Pick<PRCheckStep, 'status' | 'conclusion'>): StepOutcome {
  switch (step.conclusion ?? step.status) {
    case 'success':
      return 'success'
    case 'failure':
    case 'failed':
    case 'action_required':
    case 'cancelled':
    case 'stale':
    case 'startup_failure':
    case 'timed_out':
      return 'failure'
    case 'skipped':
    case 'neutral':
      return 'skipped'
    case null:
    default:
      return 'pending'
  }
}

export type JobStepBreakdown = {
  failed: PRCheckStep[]
  succeeded: PRCheckStep[]
  skipped: PRCheckStep[]
  pending: PRCheckStep[]
  total: number
}

export function summarizeJobSteps(job: Pick<PRCheckJob, 'steps'>): JobStepBreakdown {
  const breakdown: JobStepBreakdown = {
    failed: [],
    succeeded: [],
    skipped: [],
    pending: [],
    total: job.steps.length
  }
  for (const step of job.steps) {
    switch (resolveStepOutcome(step)) {
      case 'failure':
        breakdown.failed.push(step)
        break
      case 'success':
        breakdown.succeeded.push(step)
        break
      case 'skipped':
        breakdown.skipped.push(step)
        break
      case 'pending':
        breakdown.pending.push(step)
        break
    }
  }
  return breakdown
}
