import {
  resolveGitHubPRMergeState,
  type GitHubPRAutoMergeActionIntent,
  type GitHubPRMergeStateInput,
  type GitHubPRMergeStateKind
} from '../../../shared/github/pull-request-merge-state'
import { translate } from '@/i18n/i18n'

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

function presentAutoMergeAction(
  intent: GitHubPRAutoMergeActionIntent | null
): GitHubPRAutoMergeAction | null {
  switch (intent) {
    case null:
      return null
    case 'disable_auto_merge':
      return {
        kind: 'disable',
        label: translate('auto.components.github.pr.merge.state.48d75ae118', 'Disable auto-merge'),
        tooltip: translate(
          'auto.components.github.pr.merge.state.62703b1dc4',
          'GitHub auto-merge is enabled for this pull request'
        )
      }
    case 'merge_when_ready':
      return {
        kind: 'enable',
        label: translate('auto.components.github.pr.merge.state.b169f943e1', 'Merge when ready'),
        tooltip: translate(
          'auto.components.github.pr.merge.state.331ebe1170',
          'Add this pull request to the GitHub merge queue'
        )
      }
    case 'enable_auto_merge':
      return {
        kind: 'enable',
        label: translate('auto.components.github.pr.merge.state.4ab19a62ef', 'Enable auto-merge'),
        tooltip: translate(
          'auto.components.github.pr.merge.state.8f6cb3772f',
          'Merge this pull request automatically once requirements are met'
        )
      }
  }
}

function presentMergeStateKind(
  kind: GitHubPRMergeStateKind
): Pick<GitHubPRMergeStatePresentation, 'label' | 'tone' | 'tooltip'> {
  switch (kind) {
    case 'merged':
      return {
        label: translate('auto.components.github.pr.merge.state.83ecdbb4a6', 'Merged'),
        tone: MUTED_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.62eb8d39da',
          'This pull request is already merged'
        )
      }
    case 'closed':
      return {
        label: translate('auto.components.github.pr.merge.state.4f976d3450', 'Closed'),
        tone: DANGER_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.820fd21663',
          'This pull request is closed'
        )
      }
    case 'draft':
      return {
        label: translate('auto.components.github.pr.merge.state.ec8e2cebaa', 'Draft'),
        tone: MUTED_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.f03028e055',
          'This pull request is still a draft'
        )
      }
    case 'review_required':
      return {
        label: translate('auto.components.github.pr.merge.state.1f8eb81c0e', 'Approval required'),
        tone: WARNING_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.a20db875ed',
          'GitHub requires review approval before this pull request can merge'
        )
      }
    case 'changes_requested':
      return {
        label: translate('auto.components.github.pr.merge.state.c606463dc2', 'Changes requested'),
        tone: DANGER_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.b289646bcd',
          'GitHub reports requested changes on this pull request'
        )
      }
    case 'conflicts':
      return {
        label: translate('auto.components.github.pr.merge.state.7e8bbe3cd7', 'Conflicts'),
        tone: DANGER_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.b37d45bca9',
          'GitHub reports merge conflicts'
        )
      }
    case 'merge_queue':
    case 'merge_queue_auto_merge_on':
      return {
        label:
          kind === 'merge_queue_auto_merge_on'
            ? translate('auto.components.github.pr.merge.state.autoMergeOn', 'Auto-merge on')
            : translate('auto.components.github.pr.merge.state.b169f943e1', 'Merge when ready'),
        tone: WARNING_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.35ec24bc43',
          'This base branch uses GitHub merge queue'
        )
      }
    case 'merge_status_unavailable':
      return {
        label: translate('auto.components.github.pr.merge.state.bd4f27b50e', 'Merge'),
        tone: MUTED_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.09896aad26',
          'Merge status is unavailable for this PR'
        )
      }
    case 'behind':
      return {
        label: translate('auto.components.github.pr.merge.state.039c072f94', 'Behind'),
        tone: WARNING_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.c614e2660a',
          'Update the branch before merging'
        )
      }
    case 'blocked':
      return {
        label: translate('auto.components.github.pr.merge.state.bf5e4c6c92', 'Blocked'),
        tone: DANGER_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.1766eb46ba',
          'GitHub reports this pull request is blocked'
        )
      }
    case 'mergeable_checks_failed':
      return {
        label: translate('auto.components.github.pr.merge.state.87fa36ac83', 'Checks failed'),
        tone: DANGER_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.1432ecff30',
          'GitHub says this PR can merge, but some checks failed'
        )
      }
    case 'mergeable_checks_pending':
      return {
        label: translate('auto.components.github.pr.merge.state.4e2507176b', 'Checks pending'),
        tone: WARNING_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.9bd983ce8f',
          'GitHub says this PR can merge, but checks are still running'
        )
      }
    case 'mergeable_checks_passed':
      return {
        label: translate('auto.components.github.pr.merge.state.def355ff38', 'Able to merge'),
        tone: SUCCESS_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.e42c5bae67',
          'GitHub says this PR can merge and checks passed'
        )
      }
    case 'mergeable':
      return {
        label: translate('auto.components.github.pr.merge.state.def355ff38', 'Able to merge'),
        tone: SUCCESS_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.cbf0113af6',
          'GitHub says this PR can merge'
        )
      }
    case 'checks_passed':
      return {
        label: translate('auto.components.github.pr.merge.state.a5b66afb58', 'Checks passed'),
        tone: SUCCESS_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.fbd4f57f0a',
          'Checks passed. Merge eligibility will be checked again before merging.'
        )
      }
    case 'checking':
      return {
        label: translate('auto.components.github.pr.merge.state.f958920f3a', 'Checking'),
        tone: MUTED_TONE,
        tooltip: translate(
          'auto.components.github.pr.merge.state.a80132573b',
          'GitHub is still computing this pull request merge status'
        )
      }
  }
}

export function presentGitHubPRMergeState(
  item: GitHubPRMergeStateInput
): GitHubPRMergeStatePresentation {
  const decision = resolveGitHubPRMergeState(item)
  return {
    ...presentMergeStateKind(decision.kind),
    directMergeAvailable: decision.directMergeAvailable,
    autoMergeAction: presentAutoMergeAction(decision.autoMergeAction)
  }
}
