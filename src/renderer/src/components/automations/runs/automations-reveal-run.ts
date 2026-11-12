/** Asks the mounted virtualized run table to scroll a run row into view so it can take focus. */
export const AUTOMATIONS_REVEAL_RUN_EVENT = 'automations-reveal-run'

/**
 * `runKey` qualifies the run by its automation row (host + automation): the global Runs table
 * can list the same run id under two hosts after a migration.
 */
export type AutomationsRevealRunDetail = { runId: string; runKey?: string }

/** A run's identity across hosts: its automation row key plus the run id. */
export function automationRunFocusKey(rowKey: string, runId: string): string {
  return `${rowKey}::${runId}`
}

export function requestAutomationRunReveal(runId: string, runKey?: string): void {
  window.dispatchEvent(
    new CustomEvent<AutomationsRevealRunDetail>(AUTOMATIONS_REVEAL_RUN_EVENT, {
      detail: { runId, runKey }
    })
  )
}
