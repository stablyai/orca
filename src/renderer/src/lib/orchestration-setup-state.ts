export const ORCHESTRATION_SETUP_STATE_EVENT = 'orca:orchestration-setup-state'
export const ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY = 'orca.orchestration.setupDismissed'

export function isOrchestrationSetupDismissed(): boolean {
  return localStorage.getItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY) === '1'
}

export function notifyOrchestrationSetupStateChanged(): void {
  window.dispatchEvent(new CustomEvent(ORCHESTRATION_SETUP_STATE_EVENT))
}
