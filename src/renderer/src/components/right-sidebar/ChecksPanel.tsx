/* eslint-disable max-lines -- Why: the checks panel co-locates PR header, checks, comments,
merge actions, and conflict state in one component to keep the data flow straightforward. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, ExternalLink, RefreshCw, Check, X, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { prChecksCacheSuffix, prCommentsCacheSuffix } from '@/store/slices/github'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
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
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { buildResolveConflictsPrompt, pickDefaultSourceControlAgent } from './SourceControl'
import { buildFixBrokenChecksPrompt, getBrokenChecks } from '../pr-checks-fix-prompt'
import { CreatePullRequestDialog } from './CreatePullRequestDialog'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review'
import { toast } from 'sonner'
import {
  classifyHostedReview,
  type HostedReviewClassificationOptions
} from '../../../../shared/hosted-review-queue'
import { hostedReviewSummaryFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import {
  checksPanelAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from './checks-panel-async-result-key'

export default function ChecksPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const settings = useAppStore((s) => s.settings)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const enqueueGitHubPRRefresh = useAppStore((s) => s.enqueueGitHubPRRefresh)
  const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const remoteStatusesByWorktree = useAppStore((s) => s.remoteStatusesByWorktree)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)

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
  const [isResolvingConflictsWithAI, setIsResolvingConflictsWithAI] = useState(false)
  const [isFixingChecksWithAI, setIsFixingChecksWithAI] = useState(false)
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
  const asyncResultKeyRef = useRef<string>('')
  const refreshRequestKeyRef = useRef<string | null>(null)
  const refreshContextKeyRef = useRef<string | null>(null)

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
    refreshRequestKeyRef.current = null
  }

  // Find active worktree and repo
  const branch = activeWorktree ? activeWorktree.branch.replace(/^refs\/heads\//, '') : ''
  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(repo.path, repo.id, branch, settings, repo.connectionId)
      : ''
  const refreshContextKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}`
  if (refreshContextKey !== refreshContextKeyRef.current) {
    refreshContextKeyRef.current = refreshContextKey
    refreshRequestKeyRef.current = null
  }
  const pr: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null
  const prRefreshState = useAppStore((s) =>
    prCacheKey ? s.prRefreshStates[prCacheKey] : undefined
  )
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
  const checksCacheKey =
    repo && prNumber
      ? getGitHubRepoCacheKey(
          repo.path,
          repo.id,
          prChecksCacheSuffix(prNumber, pr?.prRepo),
          settings,
          repo.connectionId
        )
      : ''
  const commentsCacheKey =
    repo && prNumber
      ? getGitHubRepoCacheKey(
          repo.path,
          repo.id,
          prCommentsCacheSuffix(prNumber, pr?.prRepo),
          settings,
          repo.connectionId
        )
      : ''
  const checksFetchedAt = useAppStore((s) =>
    checksCacheKey ? s.checksCache[checksCacheKey]?.fetchedAt : undefined
  )
  const commentsFetchedAt = useAppStore((s) =>
    commentsCacheKey ? s.commentsCache[commentsCacheKey]?.fetchedAt : undefined
  )

  // Fetch PR data when the active worktree/branch changes.
  // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR
  // number from metadata or the visible cache whenever we have one.
  const linkedPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedPR == null ? (pr?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const activeWorktreePath = activeWorktree?.path ?? null
  const stateRequestKey =
    repo && branch
      ? checksPanelAsyncResultKey(prCacheKey, branch, prNumber, pr?.prRepo, pr?.headSha)
      : ''
  asyncResultKeyRef.current = stateRequestKey

  const isCurrentAsyncResult = useCallback(
    (requestKey: string) =>
      shouldCommitChecksPanelAsyncResult(asyncResultKeyRef.current, requestKey),
    []
  )
  useEffect(() => {
    if (isPanelVisible && repo && !isFolder && branch) {
      if (activeWorktreeId) {
        enqueueGitHubPRRefresh(activeWorktreeId, 'swr', 30)
      }
    }
  }, [repo, isFolder, branch, activeWorktreeId, enqueueGitHubPRRefresh, isPanelVisible])

  useEffect(() => {
    if (!repo || isFolder || !branch || !isPanelVisible) {
      setHostedReviewCreation(null)
      return
    }
    let stale = false
    void getHostedReviewCreationEligibility({
      repoPath: repo.path,
      ...(activeWorktreePath ? { worktreePath: activeWorktreePath } : {}),
      branch,
      base: repo.worktreeBaseRef ?? null,
      hasUncommittedChanges,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      linkedGitHubPR: linkedPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
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
    activeWorktreePath,
    branch,
    getHostedReviewCreationEligibility,
    hasUncommittedChanges,
    isFolder,
    isPanelVisible,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    repo
  ])

  useEffect(() => {
    if (
      !repo ||
      isFolder ||
      !branch ||
      !pr ||
      pr.mergeable !== 'CONFLICTING' ||
      !activeWorktreeId
    ) {
      conflictSummaryRefreshKeyRef.current = null
      setConflictDetailsRefreshing(false)
      return
    }

    const refreshKey = `${prCacheKey}::${branch}::${pr.number}`
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
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number
    }).finally(() => {
      // Why: fetchPRForBranch updates the PR cache before resolving, which
      // can rerun this effect. Only the current refresh key may clear the
      // spinner so stale requests don't race newer worktrees/branches.
      if (conflictSummaryRefreshKeyRef.current === refreshKey) {
        setConflictDetailsRefreshing(false)
      }
    })
  }, [
    repo,
    isFolder,
    branch,
    pr,
    prCacheKey,
    activeWorktreeId,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchPRForBranch
  ])

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
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          pr?.prRepo,
          pr?.headSha
        )
        const result = await fetchPRChecks(
          repo.path,
          targetPRNumber,
          branch,
          pr?.headSha,
          pr?.prRepo,
          {
            force,
            repoId: repo.id
          }
        )
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
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
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR checks:', err)
        setChecks([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          setChecksLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      branch,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRChecks,
      isCurrentAsyncResult
    ]
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
      prNumberOverride,
      prRepoOverride
    }: {
      force?: boolean
      prNumberOverride?: number | null
      prRepoOverride?: PRInfo['prRepo'] | null
    } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      const targetPRRepo = prRepoOverride ?? pr?.prRepo
      if (!repo || !targetPRNumber) {
        return
      }
      setCommentsLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          targetPRRepo,
          pr?.headSha
        )
        const result = await fetchPRComments(repo.path, targetPRNumber, {
          force,
          repoId: repo.id,
          prRepo: targetPRRepo
        })
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setComments(result)
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR comments:', err)
        setComments([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          setCommentsLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRComments,
      branch,
      isCurrentAsyncResult
    ]
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
    void fetchPRComments(repo.path, prNumber, { repoId: repo.id, prRepo: pr?.prRepo }).then(
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
  }, [repo, prNumber, pr?.prRepo, prCacheKey, isPanelVisible, fetchPRComments])

  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    const initialRequestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    const refreshRequestKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}::${Date.now()}::${Math.random()}`
    refreshRequestKeyRef.current = refreshRequestKey
    const isCurrentRequest = (): boolean => refreshRequestKeyRef.current === refreshRequestKey
    setIsRefreshing(true)
    try {
      const refreshedPR = await fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: linkedPR,
        fallbackPRNumber: fallbackGitHubPRNumber
      })
      if (!isCurrentRequest()) {
        return
      }
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
        linkedGitLabMR
      })
      if (!isCurrentRequest()) {
        return
      }
      if (refreshedPR) {
        const prRequestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          refreshedPR.number,
          refreshedPR.prRepo,
          refreshedPR.headSha
        )
        if (!isCurrentAsyncResult(initialRequestKey) && !isCurrentRequest()) {
          return
        }
        // Why: a forced PR refresh can discover the PR number before React has
        // repainted from prCache; make this refresh's follow-up checks current.
        asyncResultKeyRef.current = prRequestKey
        // Why: call fetchPRChecks directly with the refreshed PR's headSha so
        // we don't pass the stale headSha captured by `fetchChecks`'s closure
        // before the PR refresh completed (covers external force-pushes and
        // PR-number changes).
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          refreshedPR.prRepo,
          { force: true, repoId: repo.id }
        ).then(
          (result) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
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
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR checks:', err)
            setChecks([])
          }
        )
        setChecksLoading(true)
        setCommentsLoading(true)
        const refreshedComments = fetchPRComments(repo.path, refreshedPR.number, {
          force: true,
          repoId: repo.id,
          prRepo: refreshedPR.prRepo
        }).then(
          (result) => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setComments(result)
            }
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR comments:', err)
            setComments([])
          }
        )
        await Promise.all([
          refreshedChecks.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setChecksLoading(false)
            }
          }),
          refreshedComments.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setCommentsLoading(false)
            }
          })
        ])
      } else if (isCurrentRequest()) {
        setChecks([])
        setComments([])
      }
    } finally {
      if (isCurrentRequest()) {
        setIsRefreshing(false)
      }
    }
  }, [
    repo,
    branch,
    activeWorktreeId,
    prNumber,
    pr?.headSha,
    pr?.prRepo,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchHostedReviewForBranch,
    isCurrentAsyncResult
  ])

  const handleEntryRefresh = useCallback(
    (options: { refreshChecks: boolean; refreshComments: boolean }) => {
      if (!repo || !branch || !activeWorktreeId) {
        return
      }
      // Why: entering the Checks tab is automatic UI behavior, not an explicit
      // user refresh. Route PR refresh through the coordinator so rate-limit
      // guards still apply; only force detail panes that the entry freshness rule
      // already proved stale, so tab entry stays fresh without broad fan-out.
      enqueueGitHubPRRefresh(activeWorktreeId, 'active', 80)
      if (options.refreshChecks) {
        void fetchChecks({ force: true })
      }
      if (options.refreshComments) {
        void fetchComments({ force: true })
      }
    },
    [repo, branch, activeWorktreeId, enqueueGitHubPRRefresh, fetchChecks, fetchComments]
  )

  // Why: force a freshness check on each "entry" into the Checks tab so PRs
  // opened outside Orca, externally force-pushed heads, and stale checks/comments
  // appear without waiting for the cache TTL. The grace window suppresses
  // duplicate fetches from rapid show/hide toggles. See
  // docs/refresh-on-checks-tab.md.
  const entryKey =
    isPanelVisible && repo && !isFolder && branch
      ? `${activeWorktreeId ?? ''}::${repo.id}::${branch}`
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

    const now = Date.now()
    const stale = shouldEntryRefresh({
      prFetchedAt,
      checksFetchedAt,
      commentsFetchedAt,
      prNumber,
      now,
      graceMs: ENTRY_REFRESH_GRACE_MS
    })
    if (!stale) {
      return
    }
    const cutoff = now - ENTRY_REFRESH_GRACE_MS
    const refreshChecks =
      prNumber !== null && (checksFetchedAt === undefined || checksFetchedAt < cutoff)
    const refreshComments =
      prNumber !== null && (commentsFetchedAt === undefined || commentsFetchedAt < cutoff)

    // Reset polling attention state so the forced fetch's signature establishes
    // a fresh baseline rather than colliding with the previous PR's backoff.
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    handleEntryRefresh({ refreshChecks, refreshComments })
  }, [entryKey, prFetchedAt, checksFetchedAt, commentsFetchedAt, prNumber, handleEntryRefresh])

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
        title: titleDraft.trim(),
        prRepo: pr.prRepo ?? null
      })
      if (ok) {
        // Re-fetch PR to get updated title
        await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          linkedPRNumber: linkedPR,
          fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number
        })
      }
    } finally {
      setTitleSaving(false)
      setEditingTitle(false)
    }
  }, [repo, pr, titleDraft, branch, linkedPR, fallbackGitHubPRNumber, fetchPRForBranch])

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
      void resolveReviewThread(repo.path, prNumber, threadId, resolve, {
        repoId: repo.id,
        prRepo: pr?.prRepo
      }).then((ok) => {
        if (ok) {
          // Update local state to match the optimistic store update
          setComments((prev) =>
            prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
          )
        } else {
          toast.error('Could not update review thread. Check the GitHub API budget.')
        }
      })
    },
    [repo, prNumber, pr?.prRepo, resolveReviewThread]
  )

  // Why: PR conflict files come from GitHub (paths only, no per-file conflict
  // kind), so we hand them to the same prompt builder used by Source Control
  // with conflictKind left undefined. The agent picks up the rest from
  // `git status` once it lands in the worktree.
  const handleResolveConflictsWithAI = useCallback(async (): Promise<void> => {
    if (isResolvingConflictsWithAI || !activeWorktreeId || !pr) {
      return
    }
    const conflictFiles = pr.conflictSummary?.files ?? []
    setIsResolvingConflictsWithAI(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId)
      if (connectionId === undefined) {
        toast.error('Unable to resolve the workspace connection.')
        return
      }
      const store = useAppStore.getState()
      const detectedAgents =
        typeof connectionId === 'string'
          ? await store.ensureRemoteDetectedAgents(connectionId)
          : await store.ensureDetectedAgents()
      const agent = pickDefaultSourceControlAgent(store.settings?.defaultTuiAgent, detectedAgents)
      if (!agent) {
        toast.error('No AI agents detected. Configure a default agent in Settings.')
        return
      }
      const prompt = buildResolveConflictsPrompt({
        conflictOperation: 'merge',
        entries: conflictFiles.map((path) => ({ path })),
        worktreePath: activeWorktreePath ?? null
      })
      const result = launchAgentInNewTab({
        agent,
        worktreeId: activeWorktreeId,
        prompt,
        promptDelivery: 'submit-after-ready',
        launchSource: 'conflict_resolution'
      })
      if (!result) {
        toast.error('Could not build the agent launch command.')
        return
      }
      focusTerminalTabSurface(result.tabId)
      toast.success('Started an AI agent for the conflicts.')
    } finally {
      setIsResolvingConflictsWithAI(false)
    }
  }, [activeWorktreeId, activeWorktreePath, isResolvingConflictsWithAI, pr])

  const handleFixChecksWithAI = useCallback(async (): Promise<void> => {
    if (isFixingChecksWithAI || !activeWorktreeId || !pr) {
      return
    }
    const broken = getBrokenChecks(checks)
    if (broken.length === 0) {
      toast.message('No broken checks to fix.')
      return
    }
    setIsFixingChecksWithAI(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId)
      if (connectionId === undefined) {
        toast.error('Unable to resolve the workspace connection.')
        return
      }
      const store = useAppStore.getState()
      const detectedAgents =
        typeof connectionId === 'string'
          ? await store.ensureRemoteDetectedAgents(connectionId)
          : await store.ensureDetectedAgents()
      const agent = pickDefaultSourceControlAgent(store.settings?.defaultTuiAgent, detectedAgents)
      if (!agent) {
        toast.error('No AI agents detected. Configure a default agent in Settings.')
        return
      }
      const prompt = buildFixBrokenChecksPrompt({
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        checks
      })
      const result = launchAgentInNewTab({
        agent,
        worktreeId: activeWorktreeId,
        prompt,
        promptDelivery: 'submit-after-ready',
        launchSource: 'task_page'
      })
      if (!result) {
        toast.error('Could not build the agent launch command.')
        return
      }
      focusTerminalTabSurface(result.tabId)
      toast.success('Started an AI agent for the broken checks.')
    } finally {
      setIsFixingChecksWithAI(false)
    }
  }, [activeWorktreeId, checks, isFixingChecksWithAI, pr])

  // Refresh PR (passed to PRActions)
  const handleRefreshPR = useCallback(async () => {
    if (repo && branch) {
      const refreshedPR = await fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        linkedPRNumber: linkedPR,
        fallbackPRNumber: fallbackGitHubPRNumber
      })
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
        linkedGitLabMR
      })
    }
  }, [
    repo,
    branch,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    fetchPRForBranch,
    fetchHostedReviewForBranch
  ])

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

  const handleBranchChangedByPullRequestGeneration = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !activeWorktree?.path) {
      return
    }
    // Why: AI PR detail generation rebases before summarizing; if HEAD moved,
    // the dialog must push before creating from the refreshed branch state.
    setCreatePrPushFirst(true)
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId)
  }, [activeWorktree?.path, activeWorktreeId, fetchUpstreamStatus])

  const handlePullRequestCreated = useCallback(
    async (result: { number: number; url: string }): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      const initialRequestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr?.prRepo,
        pr?.headSha
      )
      setRightSidebarOpen(true)
      setRightSidebarTab('checks')
      try {
        if (activeWorktreeId) {
          await updateWorktreeMeta(activeWorktreeId, { linkedPR: result.number })
        }
        const refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          linkedPRNumber: result.number
        })
        await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          linkedGitHubPR: result.number,
          linkedGitLabMR
        })
        if (refreshedPR) {
          const requestKey = checksPanelAsyncResultKey(
            prCacheKey,
            branch,
            refreshedPR.number,
            refreshedPR.prRepo,
            refreshedPR.headSha
          )
          if (!isCurrentAsyncResult(initialRequestKey) && !isCurrentAsyncResult(requestKey)) {
            return
          }
          asyncResultKeyRef.current = requestKey
          await Promise.all([
            fetchPRChecks(
              repo.path,
              refreshedPR.number,
              branch,
              refreshedPR.headSha,
              refreshedPR.prRepo,
              {
                force: true,
                repoId: repo.id
              }
            ).then((result) => {
              if (isCurrentAsyncResult(requestKey)) {
                setChecks(result)
              }
            }),
            fetchPRComments(repo.path, refreshedPR.number, {
              force: true,
              repoId: repo.id,
              prRepo: refreshedPR.prRepo
            }).then((result) => {
              if (isCurrentAsyncResult(requestKey)) {
                setComments(result)
              }
            })
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
      isCurrentAsyncResult,
      linkedGitLabMR,
      prCacheKey,
      prNumber,
      pr?.headSha,
      pr?.prRepo,
      repo,
      setRightSidebarOpen,
      setRightSidebarTab,
      activeWorktreeId,
      updateWorktreeMeta
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
    // Why: viewer/author/requestedReviewer signals are not wired into the
    // ChecksPanel call site yet, so `state` and `requested` would mis-classify
    // every PR (collapsing to 'teammate'). Suppress those badges until the
    // inputs are available; needs-response / ready-to-merge work from PR
    // metadata alone and remain accurate.
    return badges
  }, [activeReviewClassification])

  // ── Empty state ──
  if (!activeWorktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No workspace selected</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Select a workspace to view PR checks
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
    const isQueuedPRRefresh = prRefreshState?.status === 'queued'
    const isInFlightPRRefresh = prRefreshState?.status === 'in-flight'
    const isPausedPRRefresh = prRefreshState?.status === 'paused'
    const isErroredPRRefresh = prRefreshState?.status === 'error'

    const canCreate = hostedReviewCreation?.canCreate
    const canPushCreate = hostedReviewCreation?.blockedReason === 'needs_push'
    return (
      <>
        {repo && (
          <CreatePullRequestDialog
            open={createPrDialogOpen}
            repoId={repo.id}
            repoPath={repo.path}
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath ?? repo.path}
            branch={branch}
            eligibility={hostedReviewCreation}
            pushBeforeCreate={createPrPushFirst}
            onOpenChange={setCreatePrDialogOpen}
            onPushBeforeCreate={pushBeforeCreatePullRequest}
            onBranchChangedByGeneration={handleBranchChangedByPullRequestGeneration}
            onCreated={handlePullRequestCreated}
          />
        )}
        <div className="px-4 py-6">
          <div className="text-sm font-medium text-foreground">
            {operationInProgress
              ? `${operationLabel} in progress`
              : isErroredPRRefresh
                ? 'Could not refresh pull request'
                : isQueuedPRRefresh || isInFlightPRRefresh
                  ? 'Checking for pull request'
                  : 'No pull request found'}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {operationInProgress
              ? 'PR checks will be available after the operation completes'
              : isErroredPRRefresh
                ? 'GitHub status could not be refreshed. Existing cached data was preserved.'
                : isQueuedPRRefresh
                  ? 'Waiting to refresh GitHub status for this branch'
                  : isInFlightPRRefresh
                    ? 'Refreshing GitHub status for this branch'
                    : isPausedPRRefresh
                      ? 'GitHub refresh is paused by the current rate-limit budget'
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
            className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
            title="Refresh"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
          </button>
          <button
            className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
              className="cursor-pointer rounded p-1 text-emerald-500 transition-colors hover:bg-accent hover:text-emerald-400 disabled:cursor-default disabled:opacity-50"
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
              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
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
            PR updated {new Date(pr.updatedAt).toLocaleString()}
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

        {/* Merge / Delete Workspace actions */}
        {activeWorktree && repo && (
          <PRActions pr={pr} repo={repo} worktree={activeWorktree} onRefreshPR={handleRefreshPR} />
        )}
      </div>

      <ConflictingFilesSection
        pr={pr}
        isResolvingWithAI={isResolvingConflictsWithAI}
        onResolveWithAI={() => void handleResolveConflictsWithAI()}
      />
      <MergeConflictNotice
        pr={pr}
        isRefreshingConflictDetails={isRefreshing || conflictDetailsRefreshing}
        isResolvingWithAI={isResolvingConflictsWithAI}
        onResolveWithAI={() => void handleResolveConflictsWithAI()}
      />
      {/* Why: when the PR has merge conflicts and no checks have been fetched,
          showing "No checks configured" is misleading — checks may exist but
          simply cannot run until conflicts are resolved. Hide the empty state. */}
      {!(pr.mergeable === 'CONFLICTING' && checks.length === 0 && !checksLoading) && (
        <ChecksList
          checks={checks}
          checksLoading={checksLoading}
          isFixingWithAI={isFixingChecksWithAI}
          onFixWithAI={() => void handleFixChecksWithAI()}
        />
      )}
      <PRCommentsList
        comments={comments}
        commentsLoading={commentsLoading}
        onResolve={handleResolve}
      />
    </div>
  )
}
