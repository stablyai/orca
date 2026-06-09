import type {
  CheckStatus,
  GitHubPRCheckSummary,
  PRMergeableState,
  PRReviewDecision,
  PRState
} from '../../../shared/types'
import { translate } from '@/i18n/i18n'

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
            label: translate("auto.components.github.pr.merge.state.48d75ae118", "Disable auto-merge"),
            tooltip: translate("auto.components.github.pr.merge.state.62703b1dc4", "GitHub auto-merge is enabled for this pull request")
          }
        : item.mergeQueueRequired === true
          ? {
              kind: 'enable' as const,
              label: translate("auto.components.github.pr.merge.state.b169f943e1", "Merge when ready"),
              tooltip: translate("auto.components.github.pr.merge.state.331ebe1170", "Add this pull request to the GitHub merge queue")
            }
          : null

  if (item.state === 'merged') {
    return {
      label: translate("auto.components.github.pr.merge.state.83ecdbb4a6", "Merged"),
      tone: MUTED_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.62eb8d39da", "This pull request is already merged"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'closed') {
    return {
      label: translate("auto.components.github.pr.merge.state.4f976d3450", "Closed"),
      tone: DANGER_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.820fd21663", "This pull request is closed"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'draft') {
    return {
      label: translate("auto.components.github.pr.merge.state.ec8e2cebaa", "Draft"),
      tone: MUTED_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.f03028e055", "This pull request is still a draft"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      label: translate("auto.components.github.pr.merge.state.1f8eb81c0e", "Approval required"),
      tone: WARNING_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.a20db875ed", "GitHub requires review approval before this pull request can merge"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      label: translate("auto.components.github.pr.merge.state.c606463dc2", "Changes requested"),
      tone: DANGER_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.b289646bcd", "GitHub reports requested changes on this pull request"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeQueueRequired === true) {
    return {
      label: item.autoMergeEnabled ? 'Auto-merge on' : 'Merge when ready',
      tone: WARNING_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.35ec24bc43", "This base branch uses GitHub merge queue"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (!hasFullMergeMetadata(item)) {
    return {
      label: translate("auto.components.github.pr.merge.state.bd4f27b50e", "Merge"),
      tone: MUTED_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.09896aad26", "Merge status is unavailable for this PR"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY') {
    return {
      label: translate("auto.components.github.pr.merge.state.7e8bbe3cd7", "Conflicts"),
      tone: DANGER_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.b37d45bca9", "GitHub reports merge conflicts"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return {
      label: translate("auto.components.github.pr.merge.state.039c072f94", "Behind"),
      tone: WARNING_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.c614e2660a", "Update the branch before merging"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return {
      label: translate("auto.components.github.pr.merge.state.bf5e4c6c92", "Blocked"),
      tone: DANGER_TONE,
      tooltip: translate("auto.components.github.pr.merge.state.1766eb46ba", "GitHub reports this pull request is blocked"),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    const checkState = checksState(item)
    const checkStatus =
      checkState === 'failure'
        ? {
            label: translate("auto.components.github.pr.merge.state.87fa36ac83", "Checks failed"),
            tone: DANGER_TONE,
            tooltip: translate("auto.components.github.pr.merge.state.1432ecff30", "GitHub says this PR can merge, but some checks failed")
          }
        : checkState === 'pending'
          ? {
              label: translate("auto.components.github.pr.merge.state.4e2507176b", "Checks pending"),
              tone: WARNING_TONE,
              tooltip: translate("auto.components.github.pr.merge.state.9bd983ce8f", "GitHub says this PR can merge, but checks are still running")
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
    label: translate("auto.components.github.pr.merge.state.f958920f3a", "Checking"),
    tone: MUTED_TONE,
    tooltip: translate("auto.components.github.pr.merge.state.a80132573b", "GitHub is still computing this pull request merge status"),
    directMergeAvailable: false,
    autoMergeAction
  }
}
