import type { AutomationRun } from './automation-run'

/** A run whose prompt went into a turn already answering another message: handled, with no result of its own. */
export const ANSWERED_TOGETHER_NOTICE =
  "This run's message was answered together with another message, so its result wasn't posted."

/** Builds before this fix stored such runs as failed. */
export function repairAnsweredTogetherRun(run: AutomationRun): AutomationRun {
  return run.status === 'dispatch_failed' && run.error === ANSWERED_TOGETHER_NOTICE
    ? { ...run, status: 'completed' }
    : run
}
