import type { GitHubWorkItemBackgroundStoreSnapshot } from '@/lib/github-work-item-background-request'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export type GitHubWorkItemBackgroundFallbackReason =
  | 'repo-missing'
  | 'host-unavailable'
  | 'setup-ask'
  | 'pr-start-point'
  | 'agent-unavailable'
  | 'agent-startup'

export function findPendingGitHubWorkItemCreate(
  pendingWorktreeCreations: GitHubWorkItemBackgroundStoreSnapshot['pendingWorktreeCreations'],
  request: WorktreeCreationRequest
): string | null {
  if (!request.linkedIssue && !request.linkedPR) {
    return null
  }
  const match = Object.values(pendingWorktreeCreations).find((entry) => {
    const pending = entry.request
    return (
      pending.repoId === request.repoId &&
      pending.linkedIssue === request.linkedIssue &&
      pending.linkedPR === request.linkedPR &&
      (!request.agent || pending.agent === request.agent)
    )
  })
  return match?.creationId ?? null
}
