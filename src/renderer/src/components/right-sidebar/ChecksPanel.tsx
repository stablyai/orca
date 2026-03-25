import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  ExternalLink,
  RefreshCw,
  Check,
  X,
  Pencil
} from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PRInfo, PRCheckDetail } from '../../../../shared/types'

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

const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  neutral: CircleDashed,
  skipped: CircleMinus,
  cancelled: CircleX,
  timed_out: CircleX
}

const CHECK_COLOR: Record<string, string> = {
  success: 'text-emerald-500',
  failure: 'text-rose-500',
  pending: 'text-amber-500',
  neutral: 'text-muted-foreground',
  skipped: 'text-muted-foreground/60',
  cancelled: 'text-muted-foreground/60',
  timed_out: 'text-rose-500'
}

function prStateColor(state: PRInfo['state']): string {
  switch (state) {
    case 'merged':
      return 'bg-purple-500/15 text-purple-500 border-purple-500/20'
    case 'open':
      return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20'
    case 'closed':
      return 'bg-muted text-muted-foreground border-border'
    case 'draft':
      return 'bg-muted text-muted-foreground/70 border-border'
  }
}

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)

  const [checks, setChecks] = useState<PRCheckDetail[]>([])
  const [checksLoading, setChecksLoading] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Fetch checks
  const fetchChecks = useCallback(async () => {
    if (!repo || !pr) {
      return
    }
    setChecksLoading(true)
    try {
      const result = (await window.api.gh.prChecks({
        repoPath: repo.path,
        prNumber: pr.number
      })) as PRCheckDetail[]
      setChecks(result)
    } catch (err) {
      console.warn('Failed to fetch PR checks:', err)
      setChecks([])
    } finally {
      setChecksLoading(false)
    }
  }, [repo, pr])

  // Fetch checks on mount + poll
  useEffect(() => {
    if (!pr) {
      setChecks([])
      return
    }
    void fetchChecks()
    pollRef.current = setInterval(() => void fetchChecks(), 30_000)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
    }
  }, [fetchChecks, pr])

  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    // Refresh PR data + checks
    await fetchPRForBranch(repo.path, branch)
    await fetchChecks()
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
        await fetchPRForBranch(repo.path, branch)
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

  // Open PR in browser
  const handleOpenPR = useCallback(() => {
    if (pr?.url) {
      window.api.shell.openUrl(pr.url)
    }
  }, [pr])

  // ── Empty state ──
  if (!worktree) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground px-4 text-center">
        Select a worktree to view PR checks
      </div>
    )
  }

  if (!pr) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
        <PullRequestIcon className="size-8 text-muted-foreground/30" />
        <div className="text-[11px] text-muted-foreground">
          No pull request found for this branch
        </div>
        <div className="text-[10px] text-muted-foreground/60">
          Push your branch and open a PR to see checks here
        </div>
      </div>
    )
  }

  // ── Sorted checks: failures first, then pending, then success ──
  const sortedChecks = [...checks].sort((a, b) => {
    const order = {
      failure: 0,
      timed_out: 0,
      cancelled: 1,
      pending: 2,
      neutral: 3,
      skipped: 4,
      success: 5
    }
    const aOrder = order[a.conclusion ?? 'pending'] ?? 3
    const bOrder = order[b.conclusion ?? 'pending'] ?? 3
    return aOrder - bOrder
  })

  const passingCount = checks.filter((c) => c.conclusion === 'success').length
  const failingCount = checks.filter(
    (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
  ).length
  const pendingCount = checks.filter(
    (c) => c.conclusion === 'pending' || c.conclusion === null
  ).length

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
          >
            <RefreshCw className={cn('size-3.5', checksLoading && 'animate-spin')} />
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
      </div>

      {/* Checks Summary */}
      {checks.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border text-[10px] text-muted-foreground">
          {passingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleCheck className="size-3 text-emerald-500" />
              {passingCount} passing
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {failingCount} failing
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {pendingCount} pending
            </span>
          )}
        </div>
      )}

      {/* Checks List */}
      {checksLoading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-[11px] text-muted-foreground">
          No checks configured
        </div>
      ) : (
        <div className="py-1">
          {sortedChecks.map((check) => {
            const conclusion = check.conclusion ?? 'pending'
            const Icon = CHECK_ICON[conclusion] ?? CircleDashed
            const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'

            return (
              <div
                key={check.name}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 hover:bg-accent/40 transition-colors',
                  check.url && 'cursor-pointer'
                )}
                onClick={() => {
                  if (check.url) {
                    window.api.shell.openUrl(check.url)
                  }
                }}
              >
                <Icon
                  className={cn(
                    'size-3.5 shrink-0',
                    color,
                    conclusion === 'pending' && 'animate-spin'
                  )}
                />
                <span className="flex-1 truncate text-[12px] text-foreground">{check.name}</span>
                {check.url && <ExternalLink className="size-3 text-muted-foreground/40 shrink-0" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
