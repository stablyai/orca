/* eslint-disable max-lines -- Why: the checks panel co-locates PR header, checks, comments,
merge actions, and conflict state in one component to keep the data flow straightforward. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, ExternalLink, RefreshCw, Check, X, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { isFolderRepo } from '../../../../shared/repo-kind'
import PRActions from './PRActions'
import {
  PullRequestIcon,
  prStateColor,
  ConflictingFilesSection,
  MergeConflictNotice,
  ChecksList,
  PRCommentsList
} from './checks-panel-content'
import { ENTRY_REFRESH_GRACE_MS, shouldEntryRefresh } from './checks-entry-refresh'
import type { PRInfo, PRCheckDetail, PRComment } from '../../../../shared/types'
import { getConnectionId } from '@/lib/connection-context'
import { CreatePullRequestDialog } from './CreatePullRequestDialog'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { toast } from 'sonner'
import {
  classifyHostedReview,
  type HostedReviewClassificationOptions
} from '../../../../shared/hosted-review-queue'
import { hostedReviewSummaryFromGitHubPRInfo } from '../../../../shared/hosted-review-github'

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const remoteStatusesByWorktree = useAppStore((s) => s.remoteStatusesByWorktree)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)

  // Why: the sidebar stays mounted when closed (for performance). Gate
  // polling on visibility so we don't fetch checks/comments in the background
  // when the panel isn't visible to the user.
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const isPanelVisible = rightSidebarOpen && rightSidebarTab === 'checks'

  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const fetchPRComments = useAppStore((s) => s.fetchPRComments)
  const resolveReviewThread = useAppStore((s) => s.resolveReviewThread)

  const [checks, setChecks] = useState<PRCheckDetail[]>([])
  const [checksLoading, setChecksLoading] = useState(false)
  const [comments, setComments] = useState<PRComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [emptyRefreshing, setEmptyRefreshing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [conflictDetailsRefreshing, setConflictDetailsRefreshing] = useState(false)
  const [createPrDialogOpen, setCreatePrDialogOpen] = useState(false)
  const [createPrPushFirst, setCreatePrPushFirst] = useState(false)
  const [hostedReviewCreation, setHostedReviewCreation] =
    useState<HostedReviewCreationEligibility | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef(30_000) // start at 30s, backs off to 120s
  const prevChecksRef = useRef<string>('')
  const conflictSummaryRefreshKeyRef = useRef<string | null>(null)

  // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
  // remount on worktree switch (that caused an IPC storm on Windows).
  // Reset worktree-specific local state so stale UI from the previous
  // worktree doesn't leak (e.g. mid-edit title, stale loading indicators).
  // Done during render (not useEffect) so the reset takes effect on the same
  // paint as the worktree change — useEffect would leave one render with the
  // previous worktree's stale title/loading state visible.
  const [prevActiveWorktreeId, setPrevActiveWorktreeId] = useState(activeWorktreeId)
  if (activeWorktreeId !== prevActiveWorktreeId) {
    setPrevActiveWorktreeId(activeWorktreeId)
    setEditingTitle(false)
    setTitleDraft('')
    setTitleSaving(false)
    setIsRefreshing(false)
    setEmptyRefreshing(false)
    setConflictDetailsRefreshing(false)
    setCreatePrDialogOpen(false)
    setCreatePrPushFirst(false)
    conflictSummaryRefreshKeyRef.current = null
  }

  // Find active worktree and repo
  const branch = activeWorktree ? activeWorktree.branch.replace(/^refs\/heads\//, '') : ''
  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey = repo && branch ? `${repo.id}::${branch}` : ''
  const pr: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null
  const prNumber = pr?.number ?? null
  const remoteStatus = activeWorktreeId ? remoteStatusesByWorktree[activeWorktreeId] : undefined
  const hasUncommittedChanges = activeWorktreeId
    ? (gitStatusByWorktree[activeWorktreeId]?.length ?? 0) > 0
    : false
  const conflictOperation = activeWorktreeId
    ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
    : 'unknown'

  // Why: select only timestamps (not whole cache records) so the entry-refresh
  // effect doesn't re-run on every cache mutation. See
  // docs/refresh-on-checks-tab.md.
  const prFetchedAt = useAppStore((s) =>
    prCacheKey ? s.prCache[prCacheKey]?.fetchedAt : undefined
  )
  const checksCacheKey = repo && prNumber ? `${repo.id}::pr-checks::${prNumber}` : ''
  const commentsCacheKey = repo && prNumber ? `${repo.id}::pr-comments::${prNumber}` : ''
  const checksFetchedAt = useAppStore((s) =>
    checksCacheKey ? s.checksCache[checksCacheKey]?.fetchedAt : undefined
  )
  const commentsFetchedAt = useAppStore((s) =>
    commentsCacheKey ? s.commentsCache[commentsCacheKey]?.fetchedAt : undefined
  )

  // Fetch PR data when the active worktree/branch changes.
  // Why: pass linkedPR so worktrees created from a PR (whose new local branch
  // differs from the PR's head ref) resolve via the number-based fallback.
  const linkedPR = activeWorktree?.linkedPR ?? null
  useEffect(() => {
    if (repo && !isFolder && branch) {
      void fetchPRForBranch(repo.path, branch, { repoId: repo.id, linkedPRNumber: linkedPR })
    }
  }, [repo, isFolder, branch, linkedPR, fetchPRForBranch])

  useEffect(() => {
    if (!repo || isFolder || !branch || !isPanelVisible) {
      setHostedReviewCreation(null)
      return
    }
    let stale = false
    void getHostedReviewCreationEligibility({
      repoPath: repo.path,
      branch,
      base: repo.worktreeBaseRef ?? null,
      hasUncommittedChanges,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      linkedGitHubPR: linkedPR
    })
      .then((result) => {
        if (!stale) {
          setHostedReviewCreation(result)
        }
      })
      .catch(() => {
        if (!stale) {
          setHostedReviewCreation(null)
        }
      })
    return () => {
      stale = true
    }
  }, [
    branch,
    getHostedReviewCreationEligibility,
    hasUncommittedChanges,
    isFolder,
    isPanelVisible,
    linkedPR,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    repo
  ])

  useEffect(() => {
    if (!repo || isFolder || !branch || !pr || pr.mergeable !== 'CONFLICTING') {
      conflictSummaryRefreshKeyRef.current = null
      setConflictDetailsRefreshing(false)
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
    setConflictDetailsRefreshing(true)
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      linkedPRNumber: linkedPR
    }).finally(() => {
      // Why: fetchPRForBranch updates the PR cache before resolving, which
      // can rerun this effect. Only the current refresh key may clear the
      // spinner so stale requests don't race newer worktrees/branches.
      if (conflictSummaryRefreshKeyRef.current === refreshKey) {
        setConflictDetailsRefreshing(false)
      }
    })
  }, [repo, isFolder, branch, pr, linkedPR, fetchPRForBranch])

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
          force,
          repoId: repo.id
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
    if (!prNumber || !isPanelVisible) {
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
  }, [fetchChecks, isPanelVisible, prNumber])

  // Fetch comments once when PR changes (no polling — comments change infrequently).
  // The manual refresh path calls this directly; the auto-fetch effect below uses
  // its own cancellation guard to discard stale responses after PR switches.
  const fetchComments = useCallback(
    async ({
      force = false,
      prNumberOverride
    }: { force?: boolean; prNumberOverride?: number | null } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      if (!repo || !targetPRNumber) {
        return
      }
      setCommentsLoading(true)
      try {
        const result = await fetchPRComments(repo.path, targetPRNumber, { force, repoId: repo.id })
        setComments(result)
      } catch (err) {
        console.warn('Failed to fetch PR comments:', err)
        setComments([])
      } finally {
        setCommentsLoading(false)
      }
    },
    [repo, prNumber, fetchPRComments]
  )

  useEffect(() => {
    if (!repo || !prNumber || !isPanelVisible) {
      setComments([])
      return
    }
    // Why: without this guard a slow response from a previous PR can overwrite
    // state after the user switches worktrees, showing the wrong PR's comments.
    let cancelled = false
    setCommentsLoading(true)
    void fetchPRComments(repo.path, prNumber, { repoId: repo.id }).then(
      (result) => {
        if (!cancelled) {
          setComments(result)
          setCommentsLoading(false)
        }
      },
      () => {
        if (!cancelled) {
          setComments([])
          setCommentsLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [repo, prNumber, isPanelVisible, fetchPRComments])

  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    setIsRefreshing(true)
    try {
      const refreshedPR = await fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: linkedPR
      })
      if (refreshedPR) {
        // Why: call fetchPRChecks directly with the refreshed PR's headSha so
        // we don't pass the stale headSha captured by `fetchChecks`'s closure
        // before the PR refresh completed (covers external force-pushes and
        // PR-number changes).
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          { force: true, repoId: repo.id }
        ).then(
          (result) => {
            setChecks(result)
            const signature = JSON.stringify(
              result.map((c) => `${c.name}:${c.status}:${c.conclusion}`)
            )
            pollIntervalRef.current =
              signature === prevChecksRef.current
                ? Math.min(pollIntervalRef.current * 2, 120_000)
                : 30_000
            prevChecksRef.current = signature
          },
          (err) => {
            console.warn('Failed to fetch PR checks:', err)
            setChecks([])
          }
        )
        setChecksLoading(true)
        const refreshedComments = fetchComments({
          force: true,
          prNumberOverride: refreshedPR.number
        })
        await Promise.all([
          refreshedChecks.finally(() => setChecksLoading(false)),
          refreshedComments
        ])
      } else {
        setChecks([])
        setComments([])
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [repo, branch, linkedPR, fetchPRForBranch, fetchPRChecks, fetchComments])

  // Why: force a freshness check on each "entry" into the Checks tab so PRs
  // opened outside Orca, externally force-pushed heads, and stale checks/comments
  // appear without waiting for the cache TTL. The grace window suppresses
  // duplicate fetches from rapid show/hide toggles. See
  // docs/refresh-on-checks-tab.md.
  const entryKey =
    isPanelVisible && repo && !isFolder && branch
      ? `${activeWorktreeId ?? ''}::${repo.path}::${branch}`
      : ''
  const lastEntryKeyRef = useRef<string>('')
  useEffect(() => {
    if (!entryKey) {
      // Resetting on hide is required so reopening the panel on the same PR
      // re-evaluates freshness (a prevKey !== currentKey check alone would miss
      // close-and-reopen of the same PR).
      lastEntryKeyRef.current = ''
      return
    }
    if (lastEntryKeyRef.current === entryKey) {
      return
    }
    lastEntryKeyRef.current = entryKey

    const stale = shouldEntryRefresh({
      prFetchedAt,
      checksFetchedAt,
      commentsFetchedAt,
      prNumber,
      now: Date.now(),
      graceMs: ENTRY_REFRESH_GRACE_MS
    })
    if (!stale) {
      return
    }

    // Reset polling attention state so the forced fetch's signature establishes
    // a fresh baseline rather than colliding with the previous PR's backoff.
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    void handleRefresh()
  }, [entryKey, prFetchedAt, checksFetchedAt, commentsFetchedAt, prNumber, handleRefresh])

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
        repoId: repo.id,
        prNumber: pr.number,
        title: titleDraft.trim()
      })
      if (ok) {
        // Re-fetch PR to get updated title
        await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          linkedPRNumber: linkedPR
        })
      }
    } finally {
      setTitleSaving(false)
      setEditingTitle(false)
    }
  }, [repo, pr, titleDraft, branch, linkedPR, fetchPRForBranch])

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

  const handleResolve = useCallback(
    (threadId: string, resolve: boolean) => {
      if (!repo || !prNumber) {
        return
      }
      void resolveReviewThread(repo.path, prNumber, threadId, resolve, { repoId: repo.id }).then(
        (ok) => {
          if (ok) {
            // Update local state to match the optimistic store update
            setComments((prev) =>
              prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
            )
          } else {
            toast.error('Could not update review thread. Check the GitHub API budget.')
          }
        }
      )
    },
    [repo, prNumber, resolveReviewThread]
  )

  // Refresh PR (passed to PRActions)
  const handleRefreshPR = useCallback(async () => {
    if (repo && branch) {
      await fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: linkedPR
      })
    }
  }, [repo, branch, linkedPR, fetchPRForBranch])

  // Open PR in browser
  const handleOpenPR = useCallback(() => {
    if (pr?.url) {
      window.api.shell.openUrl(pr.url)
    }
  }, [pr])

  const pushBeforeCreatePullRequest = useCallback(async (): Promise<boolean> => {
    if (!activeWorktreeId || !activeWorktree?.path) {
      return false
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        false,
        connectionId,
        activeWorktree.pushTarget
      )
      await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId)
      return true
    } catch {
      return false
    }
  }, [activeWorktree, activeWorktreeId, fetchUpstreamStatus, pushBranch])

  const handlePullRequestCreated = useCallback(
    async (result: { number: number; url: string }): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      setRightSidebarOpen(true)
      setRightSidebarTab('checks')
      try {
        const refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          linkedPRNumber: result.number
        })
        await fetchHostedReviewForBranch(repo.path, branch, {
          force: true,
          linkedGitHubPR: result.number
        })
        if (refreshedPR) {
          await Promise.all([
            fetchPRChecks(repo.path, refreshedPR.number, branch, refreshedPR.headSha, {
              force: true
            }).then(setChecks),
            fetchPRComments(repo.path, refreshedPR.number, { force: true }).then(setComments)
          ])
        }
      } catch {
        // The success toast keeps the hosted URL available; Checks can be refreshed manually.
      }
    },
    [
      branch,
      fetchHostedReviewForBranch,
      fetchPRChecks,
      fetchPRComments,
      fetchPRForBranch,
      repo,
      setRightSidebarOpen,
      setRightSidebarTab
    ]
  )

  const activeReviewClassification = React.useMemo(() => {
    if (!pr || !repo) {
      return null
    }
    let host = 'github.com'
    let owner = 'unknown'
    let repoName = 'unknown'
    try {
      const parsed = new URL(pr.url)
      host = parsed.host || host
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments.length >= 2) {
        owner = segments[0]
        repoName = segments[1]
      }
    } catch {
      // Why: malformed URLs should not block queue-state classification.
    }

    // Why: unresolved thread data is paginated and fetched separately. Until
    // comments have loaded for this PR, do not let queue badges imply a clean review.
    const commentsForClassification =
      commentsFetchedAt !== undefined && !commentsLoading ? comments : undefined
    const summary = hostedReviewSummaryFromGitHubPRInfo({
      pr,
      owner,
      repo: repoName,
      host,
      comments: commentsForClassification,
      checks
    })
    const options: HostedReviewClassificationOptions = {
      agentAuthorLogins: [],
      viewer: null
    }
    return classifyHostedReview(summary, options)
  }, [pr, repo, comments, commentsFetchedAt, commentsLoading, checks])

  const queueBadges = React.useMemo(() => {
    if (!activeReviewClassification) {
      return [] as string[]
    }
    const badges: string[] = []
    if (activeReviewClassification.needsResponse) {
      badges.push('Needs response')
    }
    if (activeReviewClassification.readyToMerge) {
      badges.push('Ready to merge')
    }
    if (activeReviewClassification.requested) {
      badges.push('Review requested')
    }
    if (activeReviewClassification.state === 'mine') {
      badges.push('My PR')
    } else if (activeReviewClassification.state === 'agent') {
      badges.push('AI PR')
    } else {
      badges.push('Teammate PR')
    }
    return badges
  }, [activeReviewClassification])

  // ── Empty state ──
  if (!activeWorktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No worktree selected</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Select a worktree to view PR checks
        </div>
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">Checks unavailable</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Checks require a Git branch and pull request context
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

    const canCreate = hostedReviewCreation?.canCreate
    const canPushCreate = hostedReviewCreation?.blockedReason === 'needs_push'
    return (
      <>
        {repo && (
          <CreatePullRequestDialog
            open={createPrDialogOpen}
            repoId={repo.id}
            repoPath={repo.path}
            branch={branch}
            eligibility={hostedReviewCreation}
            pushBeforeCreate={createPrPushFirst}
            onOpenChange={setCreatePrDialogOpen}
            onPushBeforeCreate={pushBeforeCreatePullRequest}
            onCreated={handlePullRequestCreated}
          />
        )}
        <div className="px-4 py-6">
          <div className="text-sm font-medium text-foreground">
            {operationInProgress ? `${operationLabel} in progress` : 'No pull request found'}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {operationInProgress
              ? 'PR checks will be available after the operation completes'
              : canPushCreate
                ? 'Push your branch before creating a pull request.'
                : 'Create a pull request to start checks and review.'}
          </div>
          {!operationInProgress && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(canCreate || canPushCreate) && (
                <Button
                  size="xs"
                  onClick={() => {
                    setCreatePrPushFirst(canPushCreate)
                    setCreatePrDialogOpen(true)
                  }}
                >
                  {canPushCreate ? 'Push & Create PR' : 'Create PR'}
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
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
              </Button>
            </div>
          )}
        </div>
      </>
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

        {queueBadges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {queueBadges.map((badge) => (
              <span
                key={badge}
                className="rounded border border-border bg-accent/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {badge}
              </span>
            ))}
          </div>
        )}

        {/* Merge / Delete Worktree actions */}
        {activeWorktree && repo && (
          <PRActions pr={pr} repo={repo} worktree={activeWorktree} onRefreshPR={handleRefreshPR} />
        )}
      </div>

      <ConflictingFilesSection pr={pr} />
      <MergeConflictNotice
        pr={pr}
        isRefreshingConflictDetails={isRefreshing || conflictDetailsRefreshing}
      />
      {/* Why: when the PR has merge conflicts and no checks have been fetched,
          showing "No checks configured" is misleading — checks may exist but
          simply cannot run until conflicts are resolved. Hide the empty state. */}
      {!(pr.mergeable === 'CONFLICTING' && checks.length === 0 && !checksLoading) && (
        <ChecksList checks={checks} checksLoading={checksLoading} />
      )}
      <PRCommentsList
        comments={comments}
        commentsLoading={commentsLoading}
        onResolve={handleResolve}
      />
    </div>
  )
}
