// FORK: flat row layout — minimal sidebar inspired by Kodu-style reference.
// Only shows worktree name + PR info (if exists). Status, unread, repo badge,
// branch, issue, and comment are hidden by default (still toggleable in view options).
/* eslint-disable max-lines */
import React, { useEffect, useCallback } from 'react'
import { useAppStore } from '@/store'
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import WorktreeContextMenu from './WorktreeContextMenu'
import { cn } from '@/lib/utils'
import type { Worktree, Repo, PRInfo, GitConflictOperation } from '../../../../shared/types'

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

const CONFLICT_OPERATION_LABELS: Record<Exclude<GitConflictOperation, 'unknown'>, string> = {
  merge: 'Merging',
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking'
}

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
}

function PullRequestIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.25 2.25 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1.5 1.5 0 011.5 1.5v5.628a2.25 2.25 0 101.5 0V5.5A3 3 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"
      />
    </svg>
  )
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive
}: WorktreeCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const openModal = useAppStore((s) => s.openModal)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)

  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id])

  const branch = branchDisplayName(worktree.branch)
  const prCacheKey = repo && branch ? `${repo.path}::${branch}` : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire prCache/issueCache
  const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined))

  const pr: PRInfo | null | undefined = prEntry !== undefined ? prEntry.data : undefined

  const isDeleting = deleteState?.isDeleting ?? false

  const showPR = cardProps.includes('pr')
  const showCI = cardProps.includes('ci')
  const showIssue = cardProps.includes('issue')

  // Skip GitHub fetches when the corresponding card sections are hidden.
  useEffect(() => {
    if (repo && !worktree.isBare && prCacheKey && (showPR || showCI)) {
      fetchPRForBranch(repo.path, branch)
    }
  }, [repo, worktree.isBare, fetchPRForBranch, branch, prCacheKey, showPR, showCI])

  // Issue fetching — kept for potential future use via view options
  useEffect(() => {
    if (!repo || !worktree.linkedIssue || !issueCacheKey || !showIssue) {
      return
    }
    fetchIssue(repo.path, worktree.linkedIssue)
    const interval = setInterval(() => {
      fetchIssue(repo.path, worktree.linkedIssue!)
    }, 5 * 60_000)
    return () => clearInterval(interval)
  }, [repo, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue])

  // Stable click handler – ignore clicks that are really text selections
  const handleClick = useCallback(() => {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      return
    }
    setActiveWorktree(worktree.id)
  }, [worktree.id, setActiveWorktree])

  const handleDoubleClick = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentComment: worktree.comment
    })
  }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal])

  return (
    <WorktreeContextMenu worktree={worktree}>
      <div
        className={cn(
          // FORK: flat row layout — no card borders, generous padding, subtle active highlight
          'group relative flex flex-col px-3.5 py-3 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none mx-2',
          isActive ? 'bg-black/[0.06] dark:bg-white/[0.06]' : 'hover:bg-accent/30',
          isDeleting && 'opacity-50 grayscale cursor-not-allowed'
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        aria-busy={isDeleting}
      >
        {isDeleting && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
              Deleting…
            </div>
          </div>
        )}

        {/* Line 1: Worktree name */}
        <div className="text-[14px] font-semibold text-foreground truncate leading-tight">
          {worktree.displayName}
        </div>

        {/* Line 2: PR info (only if PR exists and pr card property is enabled) */}
        {showPR && pr && (
          <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
            <PullRequestIcon
              className={cn(
                'size-3.5 shrink-0',
                pr.state === 'merged' && 'text-purple-500/80',
                pr.state === 'open' && 'text-emerald-500/80',
                pr.state === 'closed' && 'text-muted-foreground/60',
                pr.state === 'draft' && 'text-muted-foreground/50',
                (!pr.state || !['merged', 'open', 'closed', 'draft'].includes(pr.state)) &&
                  'text-muted-foreground opacity-60'
              )}
            />
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-foreground/80 font-medium shrink-0 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              #{pr.number}
            </a>
            <span className="text-[12px] text-muted-foreground truncate">{pr.title}</span>

            {/* Right side: CI check + conflict badge */}
            <div className="flex items-center gap-1.5 ml-auto shrink-0">
              {conflictOperation && conflictOperation !== 'unknown' && (
                <span className="text-[11px] text-amber-500 dark:text-amber-400 whitespace-nowrap">
                  ⚠ {CONFLICT_OPERATION_LABELS[conflictOperation]}
                </span>
              )}
              {showCI && pr.checksStatus !== 'neutral' && (
                <>
                  {pr.checksStatus === 'success' && (
                    <CircleCheck className="size-3.5 text-emerald-500" />
                  )}
                  {pr.checksStatus === 'failure' && <CircleX className="size-3.5 text-rose-500" />}
                  {pr.checksStatus === 'pending' && (
                    <LoaderCircle className="size-3.5 text-amber-500 animate-spin" />
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Conflict badge shown even without PR */}
        {!(showPR && pr) && conflictOperation && conflictOperation !== 'unknown' && (
          <div className="flex items-center gap-1 mt-1.5">
            <span className="text-[11px] text-amber-500 dark:text-amber-400">
              ⚠ {CONFLICT_OPERATION_LABELS[conflictOperation]}
            </span>
          </div>
        )}
      </div>
    </WorktreeContextMenu>
  )
})

export default WorktreeCard
