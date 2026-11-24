import type { Automation } from '../automation-definition'

type AutomationRunIdentityFields = Pick<Automation, 'projectId' | 'runContext'>

export function getAutomationLegacyRepoId(automation: Pick<Automation, 'projectId'>): string {
  return automation.projectId
}

export function getAutomationRunRepoId(automation: AutomationRunIdentityFields): string {
  return automation.runContext?.repoId ?? getAutomationLegacyRepoId(automation)
}

export function getAutomationRunProjectId(automation: AutomationRunIdentityFields): string {
  return automation.runContext?.projectId ?? getAutomationLegacyRepoId(automation)
}
