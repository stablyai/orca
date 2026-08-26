import type {
  CheckStatus,
  PullRequestMergeQueueEntry,
  PRMergeableState,
  PRReviewDecision,
  PRState,
  ProviderCheckSummary
} from '../../../shared/github/pull-request-types'
import {
  getGitHubPRMergeQueueLabel,
  getGitHubPRMergeQueueTooltip
} from './github-pr-merge-queue-presentation'
import {
  resolveGitHubPRAutoMergeAction,
  type GitHubPRAutoMergeAction
} from './github-pr-auto-merge-action'
import { translate } from '@/i18n/i18n'

export type GitHubPRMergeStateInput = {
  state: PRState
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
  reviewDecision?: PRReviewDecision | null
  checksStatus?: CheckStatus
  checksSummary?: ProviderCheckSummary
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeQueueEntry?: PullRequestMergeQueueEntry
}

export type { GitHubPRAutoMergeAction }

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

function checksPassed(item: GitHubPRMergeStateInput): boolean {
  return checksState(item) === 'success'
}

function hasFullMergeMetadata(item: GitHubPRMergeStateInput): boolean {
  return item.mergeable !== undefined || item.mergeStateStatus !== undefined
}

// Why: when GitHub already allows a direct merge, offering "Enable auto-merge"
// only yields a "clean status" rejection. Keep the Disable action so users can
// still turn off an existing auto-merge request; merge-queue "Merge when ready"
// paths set directMergeAvailable=false and never reach here.
function autoMergeActionWhenDirectMergeAvailable(
  autoMergeAction: GitHubPRAutoMergeAction | null
): GitHubPRAutoMergeAction | null {
  return autoMergeAction?.kind === 'disable' ? autoMergeAction : null
}

function passedChecksMergePresentation(
  autoMergeAction: GitHubPRAutoMergeAction | null
): GitHubPRMergeStatePresentation {
  return {
    label: translate('auto.components.github.pr.merge.state.a5b66afb58', 'Checks passed'),
    tone: SUCCESS_TONE,
    tooltip: translate(
      'auto.components.github.pr.merge.state.fbd4f57f0a',
      'Checks passed. Merge eligibility will be checked again before merging.'
    ),
    directMergeAvailable: true,
    autoMergeAction: autoMergeActionWhenDirectMergeAvailable(autoMergeAction)
  }
}

export function presentGitHubPRMergeState(
  item: GitHubPRMergeStateInput
): GitHubPRMergeStatePresentation {
  const autoMergeAction = resolveGitHubPRAutoMergeAction(item)

  if (item.state === 'merged') {
    return {
      label: translate('auto.components.github.pr.merge.state.83ecdbb4a6', 'Merged'),
      tone: MUTED_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.62eb8d39da',
        'This pull request is already merged'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'closed') {
    return {
      label: translate('auto.components.github.pr.merge.state.4f976d3450', 'Closed'),
      tone: DANGER_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.820fd21663',
        'This pull request is closed'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.state === 'draft') {
    return {
      label: translate('auto.components.github.pr.merge.state.ec8e2cebaa', 'Draft'),
      tone: MUTED_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.f03028e055',
        'This pull request is still a draft'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  // Why: must precede the mergeQueueRequired branch — that branch cannot tell
  // "base branch uses a queue" from "this PR is already sitting in it" (#12316).
  if (item.state === 'queued') {
    return {
      label: getGitHubPRMergeQueueLabel(item.mergeQueueEntry),
      tone: WARNING_TONE,
      tooltip: getGitHubPRMergeQueueTooltip(item.mergeQueueEntry),
      directMergeAvailable: false,
      autoMergeAction: null
    }
  }
  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      label: translate('auto.components.github.pr.merge.state.1f8eb81c0e', 'Approval required'),
      tone: WARNING_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.a20db875ed',
        'GitHub requires review approval before this pull request can merge'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      label: translate('auto.components.github.pr.merge.state.c606463dc2', 'Changes requested'),
      tone: DANGER_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.b289646bcd',
        'GitHub reports requested changes on this pull request'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeQueueRequired === true) {
    return {
      label: item.autoMergeEnabled ? 'Auto-merge on' : 'Merge when ready',
      tone: WARNING_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.35ec24bc43',
        'This base branch uses GitHub merge queue'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (!hasFullMergeMetadata(item)) {
    // Why: GitHub can omit merge metadata while checks are already green; let
    // users attempt merge and rely on the main-process preflight for blockers.
    if (checksPassed(item)) {
      return passedChecksMergePresentation(autoMergeAction)
    }
    return {
      label: translate('auto.components.github.pr.merge.state.bd4f27b50e', 'Merge'),
      tone: MUTED_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.09896aad26',
        'Merge status is unavailable for this PR'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY') {
    return {
      label: translate('auto.components.github.pr.merge.state.7e8bbe3cd7', 'Conflicts'),
      tone: DANGER_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.b37d45bca9',
        'GitHub reports merge conflicts'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return {
      label: translate('auto.components.github.pr.merge.state.039c072f94', 'Behind'),
      tone: WARNING_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.c614e2660a',
        'Update the branch before merging'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return {
      label: translate('auto.components.github.pr.merge.state.bf5e4c6c92', 'Blocked'),
      tone: DANGER_TONE,
      tooltip: translate(
        'auto.components.github.pr.merge.state.1766eb46ba',
        'GitHub reports this pull request is blocked'
      ),
      directMergeAvailable: false,
      autoMergeAction
    }
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    const checkState = checksState(item)
    const checkStatus =
      checkState === 'failure'
        ? {
            label: translate('auto.components.github.pr.merge.state.87fa36ac83', 'Checks failed'),
            tone: DANGER_TONE,
            tooltip: translate(
              'auto.components.github.pr.merge.state.1432ecff30',
              'GitHub says this PR can merge, but some checks failed'
            )
          }
        : checkState === 'pending'
          ? {
              label: translate(
                'auto.components.github.pr.merge.state.4e2507176b',
                'Checks pending'
              ),
              tone: WARNING_TONE,
              tooltip: translate(
                'auto.components.github.pr.merge.state.9bd983ce8f',
                'GitHub says this PR can merge, but checks are still running'
              )
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
      autoMergeAction: autoMergeActionWhenDirectMergeAvailable(autoMergeAction)
    }
  }
  // Why: GitHub may still report intermediate mergeability while checks are
  // green; the merge command re-checks authoritative blockers before merging.
  if (checksPassed(item)) {
    return passedChecksMergePresentation(autoMergeAction)
  }
  return {
    label: translate('auto.components.github.pr.merge.state.f958920f3a', 'Checking'),
    tone: MUTED_TONE,
    tooltip: translate(
      'auto.components.github.pr.merge.state.a80132573b',
      'GitHub is still computing this pull request merge status'
    ),
    directMergeAvailable: false,
    autoMergeAction
  }
}
