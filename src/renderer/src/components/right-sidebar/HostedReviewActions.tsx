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
import type { GitHubPRMergeMethod } from '../../../../shared/types'
import { resolveGitHubPRMergeMethods } from '../../../../shared/github-pr-merge-methods'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { presentGitLabMRMergeState } from './gitlab-mr-merge-state'
import { translate } from '@/i18n/i18n'

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
  const mergeMethods = useMemo(
    () => resolveGitHubPRMergeMethods(isGitLab ? null : (githubPR?.mergeMethodSettings ?? null)),
    [githubPR?.mergeMethodSettings, isGitLab]
  )
  const isUpdatingReviewState = stateUpdating !== null
  const primaryMergeDisabled =
    merging ||
    isUpdatingReviewState ||
    (!mergePresentation.directMergeAvailable && !mergePresentation.autoMergeAction)
  const directMergeDisabled =
    merging || isUpdatingReviewState || !mergePresentation.directMergeAvailable
  const menuDisabled = merging || isUpdatingReviewState

  const handleMerge = useCallback(
    async (method: GitHubPRMergeMethod = mergeMethods.defaultMethod) => {
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
    [
      githubPR?.prRepo,
      isGitLab,
      mergeMethods.defaultMethod,
      onRefreshReview,
      repo.id,
      repo.path,
      review.number
    ]
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
          ? translate("auto.components.right.sidebar.HostedReviewActions.a3d572a4de", "This will close the {{value0}}.", { value0: reviewLabel })
          : translate("auto.components.right.sidebar.HostedReviewActions.78f5ff294c", "This will reopen the {{value0}}.", { value0: reviewLabel }),
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
          toast.success(isClosing ? translate("auto.components.right.sidebar.HostedReviewActions.fa3ee9a515", "{{value0}} closed", { value0: shortLabel }) : translate("auto.components.right.sidebar.HostedReviewActions.377269db6f", "{{value0}} reopened", { value0: shortLabel }))
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
                        : void handleMerge(mergeMethods.defaultMethod)
                    }
                    disabled={primaryMergeDisabled}
                  >
                    {merging ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="size-3.5" />
                    )}
                    {merging
                      ? translate("auto.components.right.sidebar.HostedReviewActions.d2ca293f3d", "Working...")
                      : mergePresentation.directMergeAvailable
                        ? mergeMethods.defaultLabel
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
                  aria-label={translate("auto.components.right.sidebar.HostedReviewActions.2bfaf4379c", "More {{value0}} actions", { value0: reviewLabel })}
                  title={translate("auto.components.right.sidebar.HostedReviewActions.9845a71e17", "More actions")}
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
                  {translate("auto.components.right.sidebar.HostedReviewActions.4d5fb5a284", "Close")}{shortLabel}
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
          {stateUpdating === 'open' ? translate("auto.components.right.sidebar.HostedReviewActions.6645ac7dd1", "Reopening...") : translate("auto.components.right.sidebar.HostedReviewActions.3ce211ece6", "Reopen {{value0}}", { value0: shortLabel })}
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
        {isDeletingWorktree ? translate("auto.components.right.sidebar.HostedReviewActions.eefd50457e", "Deleting...") : translate("auto.components.right.sidebar.HostedReviewActions.e4aca40024", "Delete Workspace")}
      </Button>
    )
  }

  return null
}
