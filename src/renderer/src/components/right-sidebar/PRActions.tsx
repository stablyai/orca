import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, GitMerge, ChevronDown, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'

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
    openModal('delete-worktree', { worktreeId: worktree.id })
  }, [worktree.id, openModal])

  if (pr.state === 'open') {
    return (
      <div className="space-y-1.5">
        <div className="relative flex items-stretch" ref={mergeMenuRef}>
          <button
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 rounded-l-md px-3 py-1.5 text-[11px] font-medium transition-colors',
              'bg-purple-600 text-white hover:bg-purple-700',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            onClick={() => void handleMerge('squash')}
            disabled={merging}
          >
            {merging ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
            {merging ? 'Merging\u2026' : 'Squash and merge'}
          </button>
          <button
            className={cn(
              'flex items-center px-1.5 rounded-r-md border-l border-purple-700/50 transition-colors',
              'bg-purple-600 text-white hover:bg-purple-700',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            onClick={() => setMergeMenuOpen((v) => !v)}
            disabled={merging}
          >
            <ChevronDown className="size-3.5" />
          </button>
          {mergeMenuOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-popover shadow-md overflow-hidden">
              {MERGE_METHODS.map((method) => (
                <button
                  key={method}
                  className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors"
                  onClick={() => void handleMerge(method)}
                >
                  {MERGE_LABELS[method]}
                </button>
              ))}
            </div>
          )}
        </div>
        {mergeError && <div className="text-[10px] text-rose-500 break-words">{mergeError}</div>}
      </div>
    )
  }

  if (pr.state === 'merged') {
    return (
      <button
        className={cn(
          'w-full flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
          'bg-destructive text-destructive-foreground hover:bg-destructive/90'
        )}
        onClick={handleDeleteWorktree}
      >
        <Trash2 className="size-3.5" />
        Delete Worktree
      </button>
    )
  }

  return null
}
