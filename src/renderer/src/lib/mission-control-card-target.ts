import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type { ChecksPanelInnerProps } from '@/components/right-sidebar/checks-panel-inner-types'
import type { Repo, Worktree } from '../../../shared/types'

export type MissionControlCardTarget = Omit<ChecksPanelInnerProps, 'isPanelActiveOverride'>

// Why: a live worker drives the Checks panel from its own worktree, so every
// PR2-gated action (merge / push / publish / link) is fully functional.
export function buildWorkerCardTarget(
  worktree: Worktree,
  repo: Repo | null
): MissionControlCardTarget {
  return {
    worktree,
    worktreeId: worktree.id,
    repo,
    gitIdentityDisplay: getWorktreeGitIdentityDisplay(worktree),
    linkedPR: worktree.linkedPR ?? null,
    linkedGitLabMR: worktree.linkedGitLabMR ?? null,
    linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: worktree.linkedGiteaPR ?? null
  }
}

// Why: shipped work is usually torn down, so drive the panel from the director's
// repo + the shipped branch + the matched PR number. If the branch happens to
// still have a live worktree, prefer it so its actions stay functional; otherwise
// `worktree` is null and the worktree-gated actions hide themselves.
export function buildShippedCardTarget(args: {
  repo: Repo | null
  branch: string
  linkedPR: number | null
  liveWorktree?: Worktree | null
}): MissionControlCardTarget {
  const { repo, branch, linkedPR, liveWorktree } = args
  if (liveWorktree) {
    const target = buildWorkerCardTarget(liveWorktree, repo)
    // Keep the matched PR number when the worktree itself has no explicit link.
    return { ...target, linkedPR: target.linkedPR ?? linkedPR }
  }
  return {
    worktree: null,
    worktreeId: null,
    repo,
    gitIdentityDisplay: getWorktreeGitIdentityDisplay({ branch }),
    linkedPR,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null
  }
}
