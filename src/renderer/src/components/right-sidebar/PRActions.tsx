import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, GitMerge, ChevronDown, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import { runWorktreeDeleteWithToast } from '../sidebar/delete-worktree-flow'

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
  const openModal = useAppStore((s) => s.openModal)
  const skipDeleteConfirm = useAppStore((s) => s.settings?.skipDeleteWorktreeConfirm ?? false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false)
  const mergeMenuRef = useRef<HTMLDivElement>(null)

  const handleMerge = useCallback(
    async (method: 'merge' | 'squash' | 'rebase' = 'squash') => {
      setMerging(true)
      setMergeError(null)
      setMergeMenuOpen(false)
      try {
        const result = await window.api.gh.mergePR({
          repoPath: repo.path,
          prNumber: pr.number,
          method
        })
        if (!result.ok) {
          setMergeError(result.error)
        } else {
          await onRefreshPR()
        }
      } catch (err) {
        setMergeError(err instanceof Error ? err.message : 'Merge failed')
      } finally {
        setMerging(false)
      }
    },
    [repo.path, pr.number, onRefreshPR]
  )

  useEffect(() => {
    if (!mergeMenuOpen) {
      return
    }
    const handleClickOutside = (e: MouseEvent): void => {
      if (mergeMenuRef.current && !mergeMenuRef.current.contains(e.target as Node)) {
        setMergeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [mergeMenuOpen])

  const handleDeleteWorktree = useCallback(() => {
    // Why: honor the user's "don't ask again" preference from the main
    // worktree-delete dialog here too; otherwise the merged-PR shortcut would
    // still prompt after the user opted out everywhere else. Main worktrees
    // can't reach this action — PRs are opened from non-main worktrees — so
    // we don't need the main-worktree guard the context menu uses.
    if (skipDeleteConfirm) {
      runWorktreeDeleteWithToast(worktree.id, worktree.displayName)
      return
    }
    openModal('delete-worktree', { worktreeId: worktree.id })
  }, [worktree.id, worktree.displayName, openModal, skipDeleteConfirm])

  // Why: merging a PR with unresolved conflicts would fail on GitHub anyway;
  // disabling the button prevents a confusing error and signals the user must
  // resolve conflicts first.
  const hasConflicts = pr.mergeable === 'CONFLICTING'

  if (pr.state === 'open') {
    return (
      <div className="space-y-1.5">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Why: wrapping in a <span> so the tooltip trigger receives pointer
                events even when the buttons inside are disabled. */}
              <span className={cn(hasConflicts && 'cursor-not-allowed')}>
                <div
                  className={cn(
                    'relative flex items-stretch',
                    hasConflicts && 'pointer-events-none'
                  )}
                  ref={mergeMenuRef}
                >
                  <Button
                    type="button"
                    size="xs"
                    className={cn(
                      'flex-1 rounded-r-none px-3 text-[11px]',
                      'bg-green-600 text-white hover:bg-green-700',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                    onClick={() => void handleMerge('squash')}
                    disabled={merging || hasConflicts}
                  >
                    {merging ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="size-3.5" />
                    )}
                    {merging ? 'Merging\u2026' : 'Squash and merge'}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    className={cn(
                      'rounded-l-none border-l border-green-700/50 px-1.5',
                      'bg-green-600 text-white hover:bg-green-700',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                    onClick={() => setMergeMenuOpen((v) => !v)}
                    disabled={merging || hasConflicts}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                  {mergeMenuOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-popover shadow-md overflow-hidden">
                      {MERGE_METHODS.map((method) => (
                        <Button
                          key={method}
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-auto w-full justify-start rounded-none px-3 py-1 text-left text-[11px]"
                          onClick={() => void handleMerge(method)}
                        >
                          {MERGE_LABELS[method]}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </span>
            </TooltipTrigger>
            {hasConflicts && (
              <TooltipContent side="bottom" sideOffset={4}>
                Merge conflicts must be resolved before merging
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        {mergeError && <div className="text-[10px] text-rose-500 break-words">{mergeError}</div>}
      </div>
    )
  }

  if (pr.state === 'merged') {
    return (
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className="w-full text-[11px]"
        onClick={handleDeleteWorktree}
      >
        <Trash2 className="size-3.5" />
        Delete Worktree
      </Button>
    )
  }

  return null
}
