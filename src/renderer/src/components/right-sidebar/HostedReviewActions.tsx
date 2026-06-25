import React, { useCallback, useMemo } from 'react'
import { LoaderCircle, GitMerge, ChevronDown, GitPullRequestClosed } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import { resolveGitHubPRMergeMethods } from '../../../../shared/github-pr-merge-methods'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { presentGitLabMRMergeState } from './gitlab-mr-merge-state'
import {
  ClosedReviewActions,
  HostedReviewActionError,
  MergedReviewActions
} from './HostedReviewStateActions'
import { useHostedReviewActions, type HostedReviewActionInfo } from './use-hosted-review-actions'
import {
  RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS,
  RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS,
  RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS
} from './right-sidebar-primary-action-layout'
import { translate } from '@/i18n/i18n'

export default function HostedReviewActions({
  review,
  githubPR,
  repo,
  worktree,
  onRefreshReview
}: {
  review: HostedReviewActionInfo
  githubPR?: PRInfo | null
  repo: Repo
  worktree: Worktree
  onRefreshReview: () => Promise<void>
}): React.JSX.Element | null {
  const isDeletingWorktree = useAppStore(
    (s) => s.deleteStateByWorktreeId[worktree.id]?.isDeleting ?? false
  )
  const isGitLab = review.provider === 'gitlab'
  const shortLabel = isGitLab ? 'MR' : 'PR'
  const reviewLabel = isGitLab ? 'merge request' : 'pull request'
  const mergePresentation = useMemo(() => {
    if (isGitLab) {
      return { ...presentGitLabMRMergeState(review), autoMergeAction: null }
    }
    return presentGitHubPRMergeState({
      ...githubPR,
      state: review.state,
      mergeable: review.mergeable,
      mergeStateStatus: review.mergeStateStatus,
      reviewDecision: review.reviewDecision,
      checksStatus: review.status,
      autoMergeEnabled: review.autoMergeEnabled,
      autoMergeAllowed: review.autoMergeAllowed,
      mergeQueueRequired: review.mergeQueueRequired
    })
  }, [githubPR, isGitLab, review])
  const mergeMethods = useMemo(
    () => resolveGitHubPRMergeMethods(isGitLab ? null : (githubPR?.mergeMethodSettings ?? null)),
    [githubPR?.mergeMethodSettings, isGitLab]
  )
  const {
    merging,
    stateUpdating,
    actionError,
    handleMerge,
    handleAutoMerge,
    handleCloseReview,
    handleReopenReview
  } = useHostedReviewActions({
    review,
    githubPR,
    repo,
    isGitLab,
    shortLabel,
    reviewLabel,
    defaultMergeMethod: mergeMethods.defaultMethod,
    autoMergeAction: mergePresentation.autoMergeAction,
    onRefreshReview
  })
  const isUpdatingReviewState = stateUpdating !== null
  const primaryMergeDisabled =
    merging ||
    isUpdatingReviewState ||
    (!mergePresentation.directMergeAvailable && !mergePresentation.autoMergeAction)
  const directMergeDisabled =
    merging || isUpdatingReviewState || !mergePresentation.directMergeAvailable
  const menuDisabled = merging || isUpdatingReviewState

  const handleDeleteWorktree = useCallback(() => {
    // Why: route every UI delete entry point through the shared funnel so
    // skip-confirm, main-worktree, and child-workspace safeguards cannot drift.
    runWorktreeDelete(worktree.id)
  }, [worktree.id])

  if (review.state === 'open') {
    return (
      <div className="space-y-1.5">
        <TooltipProvider delayDuration={300}>
          <div className={RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Why: wrapping in a <span> so the tooltip trigger receives pointer
                  events even when the merge button inside is disabled. */}
                <span
                  className={cn(
                    'inline-flex min-w-0 max-w-full shrink',
                    primaryMergeDisabled && 'cursor-not-allowed'
                  )}
                >
                  <Button
                    type="button"
                    size="xs"
                    className={cn(
                      'rounded-r-none px-3 text-[11px]',
                      RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS,
                      'bg-green-600 text-white hover:bg-green-700',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                    onClick={() =>
                      mergePresentation.autoMergeAction && !mergePresentation.directMergeAvailable
                        ? void handleAutoMerge()
                        : void handleMerge(mergeMethods.defaultMethod)
                    }
                    disabled={primaryMergeDisabled}
                  >
                    {merging ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="size-3.5" />
                    )}
                    <span className={RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS}>
                      {merging
                        ? translate(
                            'auto.components.right.sidebar.HostedReviewActions.d2ca293f3d',
                            'Working...'
                          )
                        : mergePresentation.directMergeAvailable
                          ? mergeMethods.defaultLabel
                          : (mergePresentation.autoMergeAction?.label ?? mergePresentation.label)}
                    </span>
                  </Button>
                </span>
              </TooltipTrigger>
              {primaryMergeDisabled && (
                <TooltipContent side="bottom" sideOffset={4}>
                  {mergePresentation.tooltip}
                </TooltipContent>
              )}
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="xs"
                  className={cn(
                    'rounded-l-none border-l border-green-700/50 px-1.5 shrink-0',
                    'bg-green-600 text-white hover:bg-green-700',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                  disabled={menuDisabled}
                  aria-label={translate(
                    'auto.components.right.sidebar.HostedReviewActions.2bfaf4379c',
                    'More {{value0}} actions',
                    { value0: reviewLabel }
                  )}
                  title={translate(
                    'auto.components.right.sidebar.HostedReviewActions.9845a71e17',
                    'More actions'
                  )}
                >
                  {stateUpdating === 'closed' ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {mergePresentation.autoMergeAction && (
                  <>
                    <DropdownMenuItem
                      disabled={menuDisabled}
                      onSelect={() => void handleAutoMerge()}
                    >
                      <GitMerge className="size-3.5" />
                      {mergePresentation.autoMergeAction.label}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {mergeMethods.methods.map(({ method, label }) => (
                  <DropdownMenuItem
                    key={method}
                    disabled={directMergeDisabled}
                    onSelect={() => void handleMerge(method)}
                  >
                    <GitMerge className="size-3.5" />
                    {label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={menuDisabled}
                  onSelect={() => void handleCloseReview()}
                >
                  <GitPullRequestClosed className="size-3.5" />
                  {translate(
                    'auto.components.right.sidebar.HostedReviewActions.4d5fb5a284',
                    'Close'
                  )}{' '}
                  {shortLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipProvider>
        <HostedReviewActionError message={actionError} />
      </div>
    )
  }

  if (review.state === 'closed') {
    return (
      <ClosedReviewActions
        shortLabel={shortLabel}
        stateUpdating={stateUpdating}
        actionError={actionError}
        onReopenReview={() => void handleReopenReview()}
      />
    )
  }
  if (review.state === 'merged') {
    return (
      <MergedReviewActions
        isDeletingWorktree={isDeletingWorktree}
        onDeleteWorktree={handleDeleteWorktree}
      />
    )
  }

  return null
}
