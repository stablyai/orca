import type {
  CheckStatus,
  GitHubPRCheckSummary,
  PRMergeableState,
  PRReviewDecision,
  PRState
} from '../../../shared/types'

export type GitHubPRMergeStateInput = {
  state: PRState | 'open' | 'closed' | 'merged' | 'draft'
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
  reviewDecision?: PRReviewDecision | null
  checksStatus?: CheckStatus
  checksSummary?: GitHubPRCheckSummary
  autoMergeEnabled?: boolean
  mergeQueueRequired?: boolean | null
}

export type GitHubPRAutoMergeAction = {
  kind: 'enable' | 'disable'
  label: string
  tooltip: string
}

export type GitHubPRMergeStatePresentation = {
  label: string
  tone: string
  tooltip: string
  directMergeAvailable: boolean
  autoMergeAction: GitHubPRAutoMergeAction | null
}

const MUTED_TONE = 'border-border/60 bg-background/70 text-muted-foreground'
const SUCCESS_TONE =
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
const WARNING_TONE = 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
const DANGER_TONE = 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'

function checksState(item: GitHubPRMergeStateInput): CheckStatus | 'none' | undefined {
  if (item.checksSummary) {
    return item.checksSummary.state
  }
  return item.checksStatus
}

function hasFullMergeMetadata(item: GitHubPRMergeStateInput): boolean {
  return item.mergeable !== undefined || item.mergeStateStatus !== undefined
}

export function presentGitHubPRMergeState(
  item: GitHubPRMergeStateInput
): GitHubPRMergeStatePresentation {
  const autoMergeAction =
    item.state !== 'open'
      ? null
      : item.autoMergeEnabled === true
        ? {
            kind: 'disable' as const,
            label: 'Disable auto-merge',
            tooltip: 'GitHub auto-merge is enabled for this pull request'
          }
        : item.mergeQueueRequired === true
          ? {
              kind: 'enable' as const,
              label: 'Merge when ready',
              tooltip: 'Add this pull request to the GitHub merge queue'
            }
          : null

  if (item.state === 'merged') {
    return {
      label: 'Merged',
      tone: MUTED_TONE,
      tooltip: 'This pull request is already merged',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'closed') {
    return {
      label: 'Closed',
      tone: DANGER_TONE,
      tooltip: 'This pull request is closed',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'draft') {
    return {
      label: 'Draft',
      tone: MUTED_TONE,
      tooltip: 'This pull request is still a draft',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      label: 'Approval required',
      tone: WARNING_TONE,
      tooltip: 'GitHub requires review approval before this pull request can merge',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      label: 'Changes requested',
      tone: DANGER_TONE,
      tooltip: 'GitHub reports requested changes on this pull request',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeQueueRequired === true) {
    return {
      label: item.autoMergeEnabled ? 'Auto-merge on' : 'Merge when ready',
      tone: WARNING_TONE,
      tooltip: 'This base branch uses GitHub merge queue',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (!hasFullMergeMetadata(item)) {
    return {
      label: 'Merge',
      tone: MUTED_TONE,
      tooltip: 'Merge status is unavailable for this PR',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'CONFLICTING') {
    return {
      label: 'Conflicts',
      tone: DANGER_TONE,
      tooltip: 'GitHub reports merge conflicts',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return {
      label: 'Behind',
      tone: WARNING_TONE,
      tooltip: 'Update the branch before merging',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return {
      label: 'Blocked',
      tone: DANGER_TONE,
      tooltip: 'GitHub reports this pull request is blocked',
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    const checkState = checksState(item)
    const checkStatus =
      checkState === 'failure'
        ? {
            label: 'Checks failed',
            tone: DANGER_TONE,
            tooltip: 'GitHub says this PR can merge, but some checks failed'
          }
        : checkState === 'pending'
          ? {
              label: 'Checks pending',
              tone: WARNING_TONE,
              tooltip: 'GitHub says this PR can merge, but checks are still running'
            }
          : null
    return {
      label: checkStatus?.label ?? 'Able to merge',
      tone: checkStatus?.tone ?? SUCCESS_TONE,
      tooltip:
        checkStatus?.tooltip ??
        (checkState === 'success'
          ? 'GitHub says this PR can merge and checks passed'
          : 'GitHub says this PR can merge'),
      directMergeAvailable: true,
      autoMergeAction
    }
  }
  return {
    label: 'Unknown',
    tone: MUTED_TONE,
    tooltip: 'GitHub has not reported a final merge status',
    directMergeAvailable: false,
    autoMergeAction
  }
}
