import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, ExternalLink, RefreshCw, Check, X, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import PRActions from './PRActions'
import {
  PullRequestIcon,
  prStateColor,
  ConflictingFilesSection,
  MergeConflictNotice,
  ChecksList
} from './checks-helpers'
import type { PRInfo, PRCheckDetail } from '../../../../shared/types'

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)

  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)

  const [checks, setChecks] = useState<PRCheckDetail[]>([])
  const [checksLoading, setChecksLoading] = useState(false)
  const [emptyRefreshing, setEmptyRefreshing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef(30_000) // start at 30s, backs off to 120s
  const prevChecksRef = useRef<string>('')
  const conflictSummaryRefreshKeyRef = useRef<string | null>(null)

  // Find active worktree and repo
  const { worktree, repo } = useMemo(() => {
    if (!activeWorktreeId) {
      return { worktree: null, repo: null }
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        const r = repos.find((rp) => rp.id === wt.repoId)
        return { worktree: wt, repo: r ?? null }
      }
    }
    return { worktree: null, repo: null }
  }, [activeWorktreeId, worktreesByRepo, repos])

  const branch = worktree ? worktree.branch.replace(/^refs\/heads\//, '') : ''
  const prCacheKey = repo && branch ? `${repo.path}::${branch}` : ''
  const pr: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null
  const prNumber = pr?.number ?? null
  const conflictOperation = activeWorktreeId
    ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
    : 'unknown'

  // Fetch PR data when the active worktree/branch changes
  useEffect(() => {
    if (repo && branch) {
      void fetchPRForBranch(repo.path, branch)
    }
  }, [repo, branch, fetchPRForBranch])

  useEffect(() => {
    if (!repo || !branch || !pr || pr.mergeable !== 'CONFLICTING') {
      conflictSummaryRefreshKeyRef.current = null
      return
    }

    const refreshKey = `${repo.path}::${branch}::${pr.number}`
    if (conflictSummaryRefreshKeyRef.current === refreshKey) {
      return
    }

    // Why: the checks panel is the one place where stale conflict metadata is
    // visibly wrong. Force-refresh conflicting PRs once when the panel sees
    // them so we don't keep rendering cached branch summaries or empty file
    // lists from an older payload.
    conflictSummaryRefreshKeyRef.current = refreshKey
    void fetchPRForBranch(repo.path, branch, { force: true })
  }, [repo, branch, pr, fetchPRForBranch])

  // Fetch checks via cached store method
  const fetchChecks = useCallback(
    async ({
      force = false,
      prNumberOverride
    }: { force?: boolean; prNumberOverride?: number | null } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      if (!repo || !targetPRNumber) {
        return
      }
      setChecksLoading(true)
      try {
        const result = await fetchPRChecks(repo.path, targetPRNumber, branch, pr?.headSha, {
          force
        })
        setChecks(result)

        // Exponential backoff: if checks haven't changed, double the interval (cap 120s).
        // If they changed, reset to 30s.
        const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`))
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 30_000
        prevChecksRef.current = signature
      } catch (err) {
        console.warn('Failed to fetch PR checks:', err)
        setChecks([])
      } finally {
        setChecksLoading(false)
      }
    },
    [repo, prNumber, branch, pr?.headSha, fetchPRChecks]
  )

  // Fetch checks on mount + poll with exponential backoff
  useEffect(() => {
    if (!prNumber) {
      setChecks([])
      return
    }

    // Reset backoff state on PR change
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    let cancelled = false
    void fetchChecks()

    const schedulePoll = (): void => {
      pollRef.current = setTimeout(() => {
        void fetchChecks().then(() => {
          if (!cancelled) {
            schedulePoll()
          }
        })
      }, pollIntervalRef.current)
    }
    schedulePoll()

    return () => {
      cancelled = true
      if (pollRef.current) {
        clearTimeout(pollRef.current)
      }
    }
  }, [fetchChecks, prNumber])

  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    setIsRefreshing(true)
    try {
      const refreshedPR = await fetchPRForBranch(repo.path, branch, { force: true })
      if (refreshedPR) {
        await fetchChecks({ force: true, prNumberOverride: refreshedPR.number })
      } else {
        setChecks([])
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [repo, branch, fetchPRForBranch, fetchChecks])

  const handleStartEdit = useCallback(() => {
    if (!pr) {
      return
    }
    setTitleDraft(pr.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }, [pr])

  const handleCancelEdit = useCallback(() => {
    setEditingTitle(false)
    setTitleDraft('')
  }, [])

  const handleSaveTitle = useCallback(async () => {
    if (!repo || !pr || !titleDraft.trim() || titleDraft === pr.title) {
      setEditingTitle(false)
      return
    }
    setTitleSaving(true)
    try {
      const ok = await window.api.gh.updatePRTitle({
        repoPath: repo.path,
        prNumber: pr.number,
        title: titleDraft.trim()
      })
      if (ok) {
        // Re-fetch PR to get updated title
        await fetchPRForBranch(repo.path, branch, { force: true })
      }
    } finally {
      setTitleSaving(false)
      setEditingTitle(false)
    }
  }, [repo, pr, titleDraft, branch, fetchPRForBranch])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSaveTitle()
      } else if (e.key === 'Escape') {
        handleCancelEdit()
      }
    },
    [handleSaveTitle, handleCancelEdit]
  )

  // Refresh PR (passed to PRActions)
  const handleRefreshPR = useCallback(async () => {
    if (repo && branch) {
      await fetchPRForBranch(repo.path, branch, { force: true })
    }
  }, [repo, branch, fetchPRForBranch])

  // Open PR in browser
  const handleOpenPR = useCallback(() => {
    if (pr?.url) {
      window.api.shell.openUrl(pr.url)
    }
  }, [pr])

  // ── Empty state ──
  if (!worktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No worktree selected</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Select a worktree to view PR checks
        </div>
      </div>
    )
  }

  if (!pr) {
    // Why: during a rebase/merge/cherry-pick the worktree is on a detached
    // HEAD, so there is no branch to look up a PR for. Showing "No pull
    // request found" is misleading — the PR still exists on the original
    // branch. Show an operation-aware message instead.
    const operationInProgress = conflictOperation !== 'unknown'
    const operationLabel =
      conflictOperation === 'rebase'
        ? 'Rebase'
        : conflictOperation === 'merge'
          ? 'Merge'
          : conflictOperation === 'cherry-pick'
            ? 'Cherry-pick'
            : null

    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {operationInProgress ? `${operationLabel} in progress` : 'No pull request found'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {operationInProgress
            ? 'PR checks will be available after the operation completes'
            : 'Push your branch and open a PR to see checks here'}
        </div>
        {!operationInProgress && (
          <button
            className="mt-3 px-3 py-1 text-xs font-medium rounded-md border border-border bg-accent/50 text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            disabled={emptyRefreshing}
            onClick={() => {
              if (!activeWorktreeId) {
                return
              }
              setEmptyRefreshing(true)
              void handleRefresh().finally(() => {
                setEmptyRefreshing(false)
              })
            }}
          >
            {emptyRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto scrollbar-sleek">
      {/* PR Header */}
      <div className="px-3 py-3 border-b border-border space-y-2.5">
        {/* PR number + state badge + refresh + open link */}
        <div className="flex items-center gap-2">
          <PullRequestIcon className="size-4 text-muted-foreground shrink-0" />
          <span className="text-[12px] font-semibold text-foreground">#{pr.number}</span>
          <span
            className={cn(
              'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
              prStateColor(pr.state)
            )}
          >
            {pr.state}
          </span>
          <div className="flex-1" />
          <button
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
          </button>
          <button
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Open on GitHub"
            onClick={handleOpenPR}
          >
            <ExternalLink className="size-3.5" />
          </button>
        </div>

        {/* PR title (editable) */}
        {editingTitle ? (
          <div className="flex items-center gap-1">
            <input
              ref={titleInputRef}
              className="flex-1 text-[12px] bg-background border border-border rounded px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-ring"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              disabled={titleSaving}
            />
            <button
              className="p-1 rounded hover:bg-accent text-emerald-500 hover:text-emerald-400 transition-colors"
              title="Save"
              onClick={() => void handleSaveTitle()}
              disabled={titleSaving}
            >
              {titleSaving ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
            </button>
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Cancel"
              onClick={handleCancelEdit}
              disabled={titleSaving}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <div
            className="group/title flex items-start gap-1.5 cursor-pointer -mx-1 px-1 py-0.5 rounded hover:bg-accent/40 transition-colors"
            onClick={handleStartEdit}
          >
            <span className="text-[12px] text-foreground leading-snug flex-1">{pr.title}</span>
            <Pencil className="size-3 text-muted-foreground/40 opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        )}

        {/* Updated at */}
        {pr.updatedAt && (
          <div className="text-[10px] text-muted-foreground/60">
            Updated {new Date(pr.updatedAt).toLocaleString()}
          </div>
        )}

        {/* Merge / Delete Worktree actions */}
        {worktree && repo && (
          <PRActions pr={pr} repo={repo} worktree={worktree} onRefreshPR={handleRefreshPR} />
        )}
      </div>

      <ConflictingFilesSection pr={pr} />
      <MergeConflictNotice pr={pr} />
      {/* Why: when the PR has merge conflicts and no checks have been fetched,
          showing "No checks configured" is misleading — checks may exist but
          simply cannot run until conflicts are resolved. Hide the empty state. */}
      {!(pr.mergeable === 'CONFLICTING' && checks.length === 0 && !checksLoading) && (
        <ChecksList checks={checks} checksLoading={checksLoading} />
      )}
    </div>
  )
}
