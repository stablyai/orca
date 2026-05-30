import React, { useCallback, useState } from 'react'
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
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'

const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const

const MERGE_LABELS: Record<(typeof MERGE_METHODS)[number], string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge'
}

export default function PRActions({
  pr,
  repo,
  worktree,
  onRefreshPR
}: {
  pr: PRInfo
  repo: Repo
  worktree: Worktree
  onRefreshPR: () => Promise<void>
}): React.JSX.Element | null {
  const isDeletingWorktree = useAppStore(
    (s) => s.deleteStateByWorktreeId[worktree.id]?.isDeleting ?? false
  )
  const confirm = useConfirmationDialog()
  const [merging, setMerging] = useState(false)
  const [stateUpdating, setStateUpdating] = useState<'open' | 'closed' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const mergePresentation = presentGitHubPRMergeState(pr)
  const isUpdatingPRState = stateUpdating !== null
  const primaryMergeDisabled =
    merging ||
    isUpdatingPRState ||
    (!mergePresentation.directMergeAvailable && !mergePresentation.autoMergeAction)
  const directMergeDisabled =
    merging || isUpdatingPRState || !mergePresentation.directMergeAvailable
  const menuDisabled = merging || isUpdatingPRState

  const handleMerge = useCallback(
    async (method: 'merge' | 'squash' | 'rebase' = 'squash') => {
      setMerging(true)
      setActionError(null)
      try {
        const result = await window.api.gh.mergePR({
          repoPath: repo.path,
          repoId: repo.id,
          prNumber: pr.number,
          method,
          prRepo: pr.prRepo ?? null
        })
        if (!result.ok) {
          setActionError(result.error)
        } else {
          await onRefreshPR()
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Merge failed')
      } finally {
        setMerging(false)
      }
    },
    [repo.id, repo.path, pr.number, pr.prRepo, onRefreshPR]
  )

  const handleAutoMerge = useCallback(async () => {
    if (!mergePresentation.autoMergeAction) {
      return
    }
    const enabled = mergePresentation.autoMergeAction.kind === 'enable'
    setMerging(true)
    setActionError(null)
    try {
      const result = await window.api.gh.setPRAutoMerge({
        repoPath: repo.path,
        repoId: repo.id,
        prNumber: pr.number,
        enabled,
        prRepo: pr.prRepo ?? null
      })
      if (!result.ok) {
        setActionError(result.error)
      } else {
        await onRefreshPR()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Auto-merge update failed')
    } finally {
      setMerging(false)
    }
  }, [mergePresentation.autoMergeAction, onRefreshPR, pr.number, pr.prRepo, repo.id, repo.path])

  const handlePRStateChange = useCallback(
    async (nextState: 'open' | 'closed') => {
      if (stateUpdating) {
        return
      }
      const isClosing = nextState === 'closed'
      const label = isClosing ? 'Close' : 'Reopen'
      const confirmed = await confirm({
        title: `${label} PR #${pr.number}?`,
        description: isClosing
          ? 'This will close the pull request.'
          : 'This will reopen the pull request.',
        confirmLabel: label,
        confirmVariant: isClosing ? 'destructive' : 'default'
      })
      if (!confirmed) {
        return
      }
      setStateUpdating(nextState)
      setActionError(null)
      try {
        const result = await window.api.gh.updatePRState({
          repoPath: repo.path,
          repoId: repo.id,
          prNumber: pr.number,
          updates: { state: nextState }
        })
        if (!result.ok) {
          setActionError(result.error)
          toast.error(result.error)
        } else {
          toast.success(isClosing ? 'Pull request closed' : 'Pull request reopened')
          await onRefreshPR()
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Failed to ${label.toLowerCase()} pull request`
        setActionError(message)
        toast.error(message)
      } finally {
        setStateUpdating(null)
      }
    },
    [confirm, onRefreshPR, pr.number, repo.id, repo.path, stateUpdating]
  )

  const handleClosePR = useCallback(async () => {
    await handlePRStateChange('closed')
  }, [handlePRStateChange])

  const handleReopenPR = useCallback(async () => {
    await handlePRStateChange('open')
  }, [handlePRStateChange])

  const handleDeleteWorktree = useCallback(() => {
    // Why: route every UI delete entry point through the shared funnel so
    // skip-confirm, main-worktree, and child-workspace safeguards cannot drift.
    runWorktreeDelete(worktree.id)
  }, [worktree.id])

  if (pr.state === 'open') {
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
                  aria-label="More pull request actions"
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
                  onSelect={() => void handleClosePR()}
                >
                  <GitPullRequestClosed className="size-3.5" />
                  Close PR
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipProvider>
        {actionError && <div className="text-[10px] text-rose-500 break-words">{actionError}</div>}
      </div>
    )
  }

  if (pr.state === 'closed') {
    return (
      <div className="space-y-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-full cursor-pointer text-[11px] hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void handleReopenPR()}
          disabled={isUpdatingPRState}
        >
          {stateUpdating === 'open' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
          {stateUpdating === 'open' ? 'Reopening...' : 'Reopen PR'}
        </Button>
        {actionError && <div className="text-[10px] text-rose-500 break-words">{actionError}</div>}
      </div>
    )
  }

  if (pr.state === 'merged') {
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
