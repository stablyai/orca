/** Asks the mounted virtualized run table to scroll a run row into view so it can take focus. */
export const AUTOMATIONS_REVEAL_RUN_EVENT = 'automations-reveal-run'

export type AutomationsRevealRunDetail = { runId: string }

export function requestAutomationRunReveal(runId: string): void {
  window.dispatchEvent(
    new CustomEvent<AutomationsRevealRunDetail>(AUTOMATIONS_REVEAL_RUN_EVENT, { detail: { runId } })
  )
}
