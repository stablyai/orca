import {
  isNgitDefaultBranch,
  ngitBranchIdPrefix,
  ngitProposalName
} from '../../../../../shared/ngit/ngit-branch-names'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments/workspace-attachments'

/** The workspace already working on an item: linked to it, else on its pull request's branch. */
export function findNgitItemWorkspace(
  worktrees: readonly Worktree[],
  repo: Repo | undefined,
  item: NgitWorkItem
): Worktree | null {
  const candidates = worktrees.filter(
    (worktree) =>
      !worktree.isArchived &&
      worktree.repoId === item.repoId &&
      (!repo || !worktree.hostId || worktree.hostId === getRepoExecutionHostId(repo))
  )
  const linked = candidates.find((worktree) =>
    getWorkspaceAttachments(worktree).some(
      (attachment) =>
        attachment.provider === 'ngit' &&
        attachment.type === item.type &&
        attachment.number === item.number
    )
  )
  if (linked || item.type !== 'pr') {
    return linked ?? null
  }
  const branches = candidates.filter(
    (worktree) => worktree.branch && !isNgitDefaultBranch(worktree.branch)
  )
  const live = item.state === 'open' || item.state === 'draft'
  return (
    branches.find((worktree) => {
      const id = ngitBranchIdPrefix(worktree.branch)
      return id !== undefined && item.eventId.startsWith(id)
    }) ??
    // A branch naming another pull request is that one's, whatever else matches.
    branches.find(
      (worktree) =>
        !ngitBranchIdPrefix(worktree.branch) &&
        ((live &&
          item.branchName !== undefined &&
          ngitProposalName(worktree.branch) === ngitProposalName(item.branchName)) ||
          (item.headSha !== undefined && worktree.head === item.headSha))
    ) ??
    null
  )
}
