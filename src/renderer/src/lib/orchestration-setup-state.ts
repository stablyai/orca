export const ORCHESTRATION_SETUP_STATE_EVENT = 'orca:orchestration-setup-state'
export const ORCHESTRATION_ENABLED_STORAGE_KEY = 'orca.orchestration.enabled'
export const ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY = 'orca.orchestration.skillInstalled'
export const ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY = 'orca.orchestration.setupDismissed'

export function isOrchestrationSetupEnabled(): boolean {
  return localStorage.getItem(ORCHESTRATION_ENABLED_STORAGE_KEY) === '1'
}

export function isOrchestrationSkillMarkedInstalled(): boolean {
  return localStorage.getItem(ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY) === '1'
}

export function hasOrchestrationSetupMarker(): boolean {
  return isOrchestrationSetupEnabled() || isOrchestrationSkillMarkedInstalled()
}

export function isOrchestrationSetupDismissed(): boolean {
  return localStorage.getItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY) === '1'
}

export function notifyOrchestrationSetupStateChanged(): void {
  window.dispatchEvent(new CustomEvent(ORCHESTRATION_SETUP_STATE_EVENT))
}
