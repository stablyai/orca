import type { Automation, AutomationRun } from './automations-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { Repo } from './repo-types'
import type {
  AutomationWorkspaceProvenance,
  ClientAutomationWorkspaceProvenance
} from './worktree/types'

/** A host's cap on a client label's name snapshots. */
export const CLIENT_PROVENANCE_SNAPSHOT_MAX = 1024

type AutomationProvenanceRun = Pick<AutomationRun, 'id' | 'title' | 'runContext'>

export function buildAutomationWorkspaceProvenance(
  automation: Automation,
  run: AutomationProvenanceRun,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
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

/** What this desktop sends a host for its own run; `local` names this desktop as the automation's owner. */
export function buildClientAutomationWorkspaceProvenance(
  automation: Automation,
  run: AutomationProvenanceRun
): ClientAutomationWorkspaceProvenance {
  const {
    kind: _kind,
    createdAt: _createdAt,
    ...record
  } = buildAutomationWorkspaceProvenance(automation, run, {
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  return {
    ...record,
    // Why: a host drops a label over its snapshot cap; a long automation name should still label.
    automationNameSnapshot: record.automationNameSnapshot.slice(0, CLIENT_PROVENANCE_SNAPSHOT_MAX),
    automationRunTitleSnapshot: record.automationRunTitleSnapshot.slice(
      0,
      CLIENT_PROVENANCE_SNAPSHOT_MAX
    ),
    hostId: LOCAL_EXECUTION_HOST_ID
  }
}
