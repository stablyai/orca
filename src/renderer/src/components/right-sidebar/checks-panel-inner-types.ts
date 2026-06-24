import type { Repo, Worktree } from '../../../../shared/types'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { SourceControlLaunchActionId } from '../../../../shared/source-control-ai-actions'
import type { ChecksPanelReview } from './checks-panel-review'
import type { PRCommentGroup } from '@/lib/pr-comment-groups'

export type HostedReviewCreationSnapshot = {
  requestKey: string
  repoId: string
  worktreeId: string | null
  branch: string
  data: HostedReviewCreationEligibility
}

export type ChecksAgentComposerState = {
  actionId: SourceControlLaunchActionId
  title: string
  description: string
  prompt: string
  launchSource: 'conflict_resolution' | 'task_page'
  commentResolution?: {
    reviewContextKey: string
    provider: ChecksPanelReview['provider']
    selectedThreadIds: string[]
    selectedGroups: PRCommentGroup[]
  }
}

/**
 * Explicit target identity for the checks/PR UI. The wrapper supplies these from
 * the active worktree; a shipped-PR caller can drive the same UI from a branch/PR
 * identity. `worktree` is optional: it is required only for actions that need a
 * live local checkout (push, publish, rename, merge), which no-op when absent.
 */
export type ChecksPanelInnerProps = {
  worktree: Worktree | null
  worktreeId: string | null
  repo: Repo | null
  gitIdentityDisplay: WorktreeGitIdentityDisplay | null
  linkedPR: number | null
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
  /**
   * Overrides the panel's "is the user looking at this?" gate that throttles
   * checks/comments fetching. The Checks tab leaves it undefined (gate on the
   * active sidebar tab). An embedded host that mounts this only when on-screen
   * (PR2: an expanded Mission Control card under the Source Control tab) passes
   * `true` so fetching runs even though the active tab isn't `checks`.
   */
  isPanelActiveOverride?: boolean
}
