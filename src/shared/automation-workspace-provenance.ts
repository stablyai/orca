import type { Automation, AutomationRun } from './automations-types'
import { getRepoExecutionHostId } from './execution-host'
import type { AutomationWorkspaceProvenance, Repo } from './types'

type AutomationProvenanceRun = Pick<AutomationRun, 'id' | 'title' | 'runContext'>

export function buildAutomationWorkspaceProvenance(
  automation: Automation,
  run: AutomationProvenanceRun,
  repo: Repo,
  createdAt = Date.now()
): AutomationWorkspaceProvenance {
  return {
    kind: 'created-by-automation',
    automationId: automation.id,
    automationNameSnapshot: automation.name,
    automationRunId: run.id,
    automationRunTitleSnapshot: run.title,
    createdAt,
    executionTargetType: automation.executionTargetType,
    executionTargetId: automation.executionTargetId,
    projectId:
      run.runContext?.projectId ?? automation.runContext?.projectId ?? automation.projectId,
    ...(run.runContext?.repoId
      ? { repoId: run.runContext.repoId }
      : automation.runContext?.repoId
        ? { repoId: automation.runContext.repoId }
        : {}),
    hostId: run.runContext?.hostId ?? automation.runContext?.hostId ?? getRepoExecutionHostId(repo)
  }
}
