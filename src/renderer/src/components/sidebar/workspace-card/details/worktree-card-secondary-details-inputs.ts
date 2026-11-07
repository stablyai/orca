import type { WorktreeCardProps } from '../controller/worktree-card-model'
import type { useWorktreeCardFoundation } from '../controller/use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import type { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>
type ReviewDetails = ReturnType<typeof useWorktreeCardReviewDetails>

export type WorktreeCardSecondaryDetailsInputs = Pick<
  WorktreeCardProps,
  'worktree' | 'repo' | 'statusPrDisplay'
> &
  Pick<
    Foundation,
    | 'newCardStyle'
    | 'compactCards'
    | 'cardDetails'
    | 'agentActivityDisplayMode'
    | 'workspacePorts'
    | 'openTaskPage'
    | 'updateWorktreeMeta'
    | 'settings'
  > &
  Pick<LinkedDetails, 'issueDisplay' | 'linearIssue' | 'linearIssueDisplay' | 'jiraIssueDisplay'> &
  Pick<
    ReviewDetails,
    'prDisplay' | 'linkedGitLabMR' | 'linkedBitbucketPR' | 'linkedAzureDevOpsPR' | 'linkedGiteaPR'
  > & {
    showStatus: boolean
    showIssue: boolean
    showLinearIssue: boolean
    showJiraIssue: boolean
    showPR: boolean
    showAutomation: boolean
    showCli: boolean
    showComment: boolean
    showPorts: boolean
  }
