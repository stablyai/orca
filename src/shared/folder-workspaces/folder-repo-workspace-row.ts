import { DEFAULT_WORKSPACE_STATUS_ID } from '../workspace/status/workspace-statuses'
import type { Repo } from '../repository/repo-types'
import type { WorktreeMeta } from '../worktree/meta-types'
import type { Worktree } from '../worktree/types'
import { getRepoMainWorktreeId } from '../worktree/id'
import { normalizeWorkspaceCreatorProvenance } from '../workspace/identity/workspace-creator-provenance'

export function mergeFolderRepoWorkspace(
  repo: Repo,
  worktreeId: string,
  meta: Partial<WorktreeMeta>
): Worktree {
  const creatorProvenance = normalizeWorkspaceCreatorProvenance(meta.creatorProvenance)
  const isMainWorktree = worktreeId === getRepoMainWorktreeId(repo)
  const followsChatName =
    isMainWorktree &&
    repo.chatWorkspace &&
    !meta.displayNameIsPinned &&
    meta.displayName === repo.chatWorkspace.initialName
  return {
    id: worktreeId,
    ...(meta.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId: repo.id,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    ...(meta.hostId !== undefined ? { hostId: meta.hostId } : {}),
    ...(meta.projectHostSetupId !== undefined
      ? { projectHostSetupId: meta.projectHostSetupId }
      : {}),
    ...(creatorProvenance ? { creatorProvenance } : {}),
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree,
    displayName: followsChatName ? repo.displayName : meta.displayName || repo.displayName,
    comment: meta.comment || '',
    linkedIssue: meta.linkedIssue ?? null,
    linkedPR: meta.linkedPR ?? null,
    linkedLinearIssue: meta.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: meta.linkedLinearIssueWorkspaceId ?? null,
    linkedLinearIssueOrganizationUrlKey: meta.linkedLinearIssueOrganizationUrlKey ?? null,
    linkedGitLabMR: meta.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta.linkedGitLabIssue ?? null,
    linkedBitbucketPR: meta.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: meta.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: meta.linkedGiteaPR ?? null,
    linkedWorkItem: meta.linkedWorkItem ?? null,
    ...(meta.linkedItems !== undefined ? { linkedItems: meta.linkedItems } : {}),
    linkedTaskSourceContext: meta.linkedTaskSourceContext ?? null,
    isArchived: meta.isArchived ?? false,
    isUnread: meta.isUnread ?? false,
    isPinned: meta.isPinned ?? false,
    sortOrder: meta.sortOrder ?? 0,
    ...(meta.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    lastActivityAt: meta.lastActivityAt ?? 0,
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta.createdWithAgent !== undefined ? { createdWithAgent: meta.createdWithAgent } : {}),
    ...(meta.automationProvenance !== undefined
      ? { automationProvenance: meta.automationProvenance }
      : {}),
    ...(meta.cliProvenance !== undefined ? { cliProvenance: meta.cliProvenance } : {}),
    ...(meta.priorWorktreeIds !== undefined ? { priorWorktreeIds: meta.priorWorktreeIds } : {}),
    workspaceStatus: meta.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    diffComments: meta.diffComments,
    mobileDiffReview: meta.mobileDiffReview
  }
}
