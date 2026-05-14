export const ORCHESTRATION_SETUP_STATE_EVENT = 'orca:orchestration-setup-state'

export function isOrchestrationSetupEnabled(): boolean {
  return localStorage.getItem('orca.orchestration.enabled') === '1'
}

export function isOrchestrationSkillMarkedInstalled(): boolean {
  return localStorage.getItem('orca.orchestration.skillInstalled') === '1'
}

export function hasOrchestrationSetupMarker(): boolean {
  return isOrchestrationSetupEnabled() || isOrchestrationSkillMarkedInstalled()
}

export function isOrchestrationSetupDismissed(): boolean {
  return localStorage.getItem('orca.orchestration.setupDismissed') === '1'
}

export function notifyOrchestrationSetupStateChanged(): void {
  window.dispatchEvent(new CustomEvent(ORCHESTRATION_SETUP_STATE_EVENT))
}
