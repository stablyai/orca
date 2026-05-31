/* eslint-disable max-lines -- Why: Checks owns one compact hosted-review action bar; keeping GitHub PR and GitLab MR action branching together keeps provider parity visible. */
import React, { useCallback, useMemo, useState } from 'react'
import {
  LoaderCircle,
  GitMerge,
  ChevronDown,
  Trash2,
  GitPullRequestClosed,
  CircleDot
} from 'lucide-react'
import { toast } from 'sonner'
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
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'

const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const

const MERGE_LABELS: Record<(typeof MERGE_METHODS)[number], string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge'
}

type HostedReviewActionInfo = Pick<
  HostedReviewInfo,
  'provider' | 'number' | 'state' | 'status' | 'mergeable'
> &
  Partial<
    Pick<
      HostedReviewInfo,
      'reviewDecision' | 'autoMergeEnabled' | 'mergeQueueRequired' | 'mergeStateStatus'
    >
  >

function presentGitLabMRMergeState(review: HostedReviewActionInfo): {
  label: string
  tooltip: string
  directMergeAvailable: boolean
} {
  if (review.state === 'merged') {
    return {
      label: 'Merged',
      tooltip: 'This merge request is already merged',
      directMergeAvailable: false
    }
  }
  if (review.state === 'closed') {
    return {
      label: 'Closed',
      tooltip: 'This merge request is closed',
      directMergeAvailable: false
    }
  }
  if (review.state === 'draft') {
    return {
      label: 'Draft',
      tooltip: 'This merge request is still a draft',
      directMergeAvailable: false
    }
  }
  if (review.mergeable === 'CONFLICTING') {
    return {
      label: 'Conflicts',
      tooltip: 'GitLab reports merge conflicts',
      directMergeAvailable: false
    }
  }
  if (review.status === 'failure') {
    return {
      label: 'Checks failed',
      tooltip: 'GitLab says this MR can merge, but some pipeline jobs failed',
      directMergeAvailable: true
    }
  }
  if (review.status === 'pending') {
    return {
      label: 'Checks pending',
      tooltip: 'GitLab says this MR can merge, but the pipeline is still running',
      directMergeAvailable: true
    }
  }
  return {
    label: 'Able to merge',
    tooltip:
      review.mergeable === 'UNKNOWN'
        ? 'GitLab has not reported a final merge status'
        : 'GitLab says this MR can merge',
    directMergeAvailable: true
  }
}

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
  const confirm = useConfirmationDialog()
  const [merging, setMerging] = useState(false)
  const [stateUpdating, setStateUpdating] = useState<'open' | 'closed' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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
      mergeQueueRequired: review.mergeQueueRequired
    })
  }, [githubPR, isGitLab, review])
  const isUpdatingReviewState = stateUpdating !== null
  const primaryMergeDisabled =
    merging ||
    isUpdatingReviewState ||
    (!mergePresentation.directMergeAvailable && !mergePresentation.autoMergeAction)
  const directMergeDisabled =
    merging || isUpdatingReviewState || !mergePresentation.directMergeAvailable
  const menuDisabled = merging || isUpdatingReviewState

  const handleMerge = useCallback(
    async (method: 'merge' | 'squash' | 'rebase' = 'squash') => {
      setMerging(true)
      setActionError(null)
      try {
        const result = isGitLab
          ? await window.api.gl.mergeMR({
              repoPath: repo.path,
              iid: review.number,
              method
            })
          : await window.api.gh.mergePR({
              repoPath: repo.path,
              repoId: repo.id,
              prNumber: review.number,
              method,
              prRepo: githubPR?.prRepo ?? null
            })
        if (!result.ok) {
          setActionError(result.error)
        } else {
          await onRefreshReview()
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Merge failed')
      } finally {
        setMerging(false)
      }
    },
    [githubPR?.prRepo, isGitLab, onRefreshReview, repo.id, repo.path, review.number]
  )

  const handleAutoMerge = useCallback(async () => {
    if (isGitLab || !mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMerging(true)
    setActionError(null)
    try {
      const result = await window.api.gh.setPRAutoMerge({
        repoPath: repo.path,
        repoId: repo.id,
        prNumber: review.number,
        enabled,
        prRepo: githubPR?.prRepo ?? null
      })
      if (!result.ok) {
        setActionError(result.error)
      } else {
        await onRefreshReview()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Auto-merge update failed')
    } finally {
      setMerging(false)
    }
  }, [
    githubPR?.prRepo,
    isGitLab,
    mergePresentation.autoMergeAction,
    onRefreshReview,
    repo.id,
    repo.path,
    review.number
  ])

  const handleReviewStateChange = useCallback(
    async (nextState: 'open' | 'closed') => {
      if (stateUpdating) {
        return
      }
      const isClosing = nextState === 'closed'
      const label = isClosing ? 'Close' : 'Reopen'
      const confirmed = await confirm({
        title: `${label} ${shortLabel} ${isGitLab ? '!' : '#'}${review.number}?`,
        description: isClosing
          ? `This will close the ${reviewLabel}.`
          : `This will reopen the ${reviewLabel}.`,
        confirmLabel: label,
        confirmVariant: isClosing ? 'destructive' : 'default'
      })
      if (!confirmed) {
        return
      }
      setStateUpdating(nextState)
      setActionError(null)
      try {
        const result = isGitLab
          ? isClosing
            ? await window.api.gl.closeMR({ repoPath: repo.path, iid: review.number })
            : await window.api.gl.reopenMR({ repoPath: repo.path, iid: review.number })
          : await window.api.gh.updatePRState({
              repoPath: repo.path,
              repoId: repo.id,
              prNumber: review.number,
              updates: { state: nextState }
            })
        if (!result.ok) {
          setActionError(result.error)
          toast.error(result.error)
        } else {
          toast.success(isClosing ? `${shortLabel} closed` : `${shortLabel} reopened`)
          await onRefreshReview()
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Failed to ${label.toLowerCase()} ${reviewLabel}`
        setActionError(message)
        toast.error(message)
      } finally {
        setStateUpdating(null)
      }
    },
    [
      confirm,
      isGitLab,
      onRefreshReview,
      repo.id,
      repo.path,
      review.number,
      reviewLabel,
      shortLabel,
      stateUpdating
    ]
  )

  const handleCloseReview = useCallback(async () => {
    await handleReviewStateChange('closed')
  }, [handleReviewStateChange])

  const handleReopenReview = useCallback(async () => {
    await handleReviewStateChange('open')
  }, [handleReviewStateChange])

  const handleDeleteWorktree = useCallback(() => {
    // Why: route every UI delete entry point through the shared funnel so
    // skip-confirm, main-worktree, and child-workspace safeguards cannot drift.
    runWorktreeDelete(worktree.id)
  }, [worktree.id])

  if (review.state === 'open') {
    return (
      <div className="space-y-1.5">
        <TooltipProvider delayDuration={300}>
          <div className="flex items-stretch">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Why: wrapping in a <span> so the tooltip trigger receives pointer
                  events even when the merge button inside is disabled. */}
                <span className={cn('flex flex-1', primaryMergeDisabled && 'cursor-not-allowed')}>
                  <Button
                    type="button"
                    size="xs"
                    className={cn(
                      'w-full rounded-r-none px-3 text-[11px]',
                      'bg-green-600 text-white hover:bg-green-700',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                    onClick={() =>
                      mergePresentation.autoMergeAction && !mergePresentation.directMergeAvailable
                        ? void handleAutoMerge()
                        : void handleMerge('squash')
                    }
                    disabled={primaryMergeDisabled}
                  >
                    {merging ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="size-3.5" />
                    )}
                    {merging
                      ? 'Working...'
                      : mergePresentation.directMergeAvailable
                        ? 'Squash and merge'
                        : (mergePresentation.autoMergeAction?.label ?? mergePresentation.label)}
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
                  aria-label={`More ${reviewLabel} actions`}
                  title="More actions"
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
                {MERGE_METHODS.map((method) => (
                  <DropdownMenuItem
                    key={method}
                    disabled={directMergeDisabled}
                    onSelect={() => void handleMerge(method)}
                  >
                    <GitMerge className="size-3.5" />
                    {MERGE_LABELS[method]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={menuDisabled}
                  onSelect={() => void handleCloseReview()}
                >
                  <GitPullRequestClosed className="size-3.5" />
                  Close {shortLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipProvider>
        {actionError && <div className="text-[10px] text-rose-500 break-words">{actionError}</div>}
      </div>
    )
  }

  if (review.state === 'closed') {
    return (
      <div className="space-y-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-full cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void handleReopenReview()}
          disabled={isUpdatingReviewState}
        >
          {stateUpdating === 'open' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
          {stateUpdating === 'open' ? 'Reopening...' : `Reopen ${shortLabel}`}
        </Button>
        {actionError && <div className="text-[10px] text-rose-500 break-words">{actionError}</div>}
      </div>
    )
  }

  if (review.state === 'merged') {
    return (
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className="w-full cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleDeleteWorktree}
        disabled={isDeletingWorktree}
      >
        {isDeletingWorktree ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        {isDeletingWorktree ? 'Deleting...' : 'Delete Workspace'}
      </Button>
    )
  }

  return null
}
