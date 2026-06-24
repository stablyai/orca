import { useAppStore } from '@/store'
import {
  buildWorkItemOrchestratorName,
  buildWorkItemOrchestratorPrompt,
  type OrchestratorWorkItemInput
} from '@/lib/orchestrator-work-item-prompt'

// Why: a director plans/decomposes a whole issue into worktrees+PRs, so handing
// it a tracked issue is a different act than the 1:1 "create a worktree from this
// issue" flow. We open the Orcastrator launch modal (which owns project/agent/name
// selection) prefilled with the issue, rather than launching blind — Jira/Linear
// issues aren't repo-bound, so the user must still confirm the target project.

export type { OrchestratorWorkItemInput }

function resolveProjectIdForRepo(repoId: string | undefined): string | null {
  if (!repoId) {
    return null
  }
  const project = useAppStore
    .getState()
    .projects.find((candidate) => candidate.sourceRepoIds.includes(repoId))
  return project?.id ?? null
}

/**
 * Open the Orcastrator launch modal prefilled from a tracked issue. The modal
 * pre-selects the project when the issue is repo-bound; otherwise the user picks
 * one. The issue becomes the director's initial `/orcastrate` task.
 */
export function openOrchestratorLaunchForWorkItem(item: OrchestratorWorkItemInput): void {
  useAppStore.getState().openModal('orchestrator-launch', {
    prefillName: buildWorkItemOrchestratorName(item),
    prefillPrompt: buildWorkItemOrchestratorPrompt(item),
    prefillProjectId: resolveProjectIdForRepo(item.repoId)
  })
}
