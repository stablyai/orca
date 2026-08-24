import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import {
  getWorkItemDetailsCacheKey,
  subscribeWorkItemDetailsCache,
  touchWorkItemDetailsCache,
  WORK_ITEM_DETAILS_FRESH_MS,
  workItemDetailsCache,
  workItemDetailsCacheGeneration
} from '@/components/pull-request-page/cache/work-item-details'
import type { PRComment } from '../../../../shared/github/comment-types'

const EMPTY_COMMENTS: PRComment[] = []

export type LocalPRReviewThreads = {
  /** Review-thread comments of the worktree's linked PR; empty while loading or when no PR is linked. */
  comments: PRComment[]
  prNumber: number | null
  repoId: string | null
  repoPath: string | null
  /** Head commit of the PR on GitHub; anchors are exact when the local head matches. */
  prHeadSha: string | undefined
}

/**
 * Read-only review threads for the GitHub PR linked to a worktree's branch.
 * Shares the PR page's details cache (same key), so opening either surface
 * warms the other; no fetch happens without a linked PR.
 */
export function useLocalPRReviewThreads(
  worktreeId: string | null | undefined,
  enabled: boolean
): LocalPRReviewThreads {
  const worktree = useAppStore((s) =>
    enabled && worktreeId ? findWorktreeById(s.worktreesByRepo, worktreeId) : undefined
  )
  // Why: manual checkouts of a PR branch never get linkedPR set; the hosted
  // review cache (kept fresh by the source-control panel) knows the PR anyway.
  const hostedReviewPRNumber = useAppStore((s) => {
    if (!worktree || worktree.linkedPR !== null) {
      return null
    }
    // Why: worktree.branch is a full ref; hosted-review keys use the short name.
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const suffix = `::${worktree.repoId}::${branch}`
    for (const [key, entry] of Object.entries(s.hostedReviewCache)) {
      if (
        key.endsWith(suffix) &&
        entry.data?.provider === 'github' &&
        Number.isInteger(entry.data.number) &&
        entry.data.number > 0
      ) {
        return entry.data.number
      }
    }
    return null
  })
  const prNumber = worktree?.linkedPR ?? hostedReviewPRNumber
  const repoId = worktree?.repoId ?? null
  const repo = useAppStore((s) => (repoId ? s.repos.find((r) => r.id === repoId) : undefined))
  const repoPath = repo?.path ?? worktree?.path ?? null
  const issueSourcePreference = repo?.issueSourcePreference

  const detailsCacheKey =
    enabled && prNumber !== null && repoId && repoPath
      ? getWorkItemDetailsCacheKey({
          repoPath,
          repoId,
          issueSourcePreference,
          type: 'pr',
          number: prNumber
        })
      : null

  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Why: a cross-window mutation deletes the shared entry without changing our
  // deps; without a tick the threads would blank until the surface remounts.
  const [refetchTick, setRefetchTick] = useState(0)
  useEffect(() => {
    if (detailsCacheKey && !cachedEntry) {
      setRefetchTick((n) => n + 1)
    }
  }, [cachedEntry, detailsCacheKey])

  // Why: comments change on github.com while Orca is in the background; returning
  // focus re-runs the fetch effect, whose 30s freshness gate keeps this cheap.
  useEffect(() => {
    if (!detailsCacheKey) {
      return
    }
    const onFocus = (): void => setRefetchTick((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [detailsCacheKey])

  useEffect(() => {
    if (!detailsCacheKey || prNumber === null || !repoId || !repoPath) {
      return
    }
    const cached = workItemDetailsCache.get(detailsCacheKey)
    if (
      cached?.pending ||
      (cached?.details && Date.now() - cached.fetchedAt <= WORK_ITEM_DETAILS_FRESH_MS)
    ) {
      return
    }
    const pending = lookupGitHubWorkItemDetailsForSource({
      repoPath,
      repoId,
      number: prNumber,
      type: 'pr'
    })
    // Why: the cache is shared with the PR page — a mutation there invalidates
    // the key mid-flight, and writing this stale result back would repaint
    // pre-mutation comments on that surface too.
    const launchedAtGeneration = workItemDetailsCacheGeneration.current
    const invalidatedMidFlight = (): boolean =>
      workItemDetailsCacheGeneration.current !== launchedAtGeneration &&
      workItemDetailsCache.get(detailsCacheKey)?.pending !== pending
    touchWorkItemDetailsCache(detailsCacheKey, {
      details: cached?.details ?? null,
      fetchedAt: cached?.fetchedAt ?? 0,
      pending
    })
    pending
      .then((details) => {
        if (invalidatedMidFlight()) {
          return
        }
        touchWorkItemDetailsCache(detailsCacheKey, {
          // Why: a null refresh must not blank details another surface already painted.
          details: details ?? workItemDetailsCache.get(detailsCacheKey)?.details ?? null,
          fetchedAt: Date.now()
        })
      })
      .catch((error: unknown) => {
        if (invalidatedMidFlight()) {
          return
        }
        const prev = workItemDetailsCache.get(detailsCacheKey)
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: prev?.details ?? null,
          fetchedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }, [detailsCacheKey, prNumber, refetchTick, repoId, repoPath])

  const details = cachedEntry?.details ?? null
  const comments = useMemo(
    // Why: only review comments carry a path; conversation comments never render in a diff.
    () => details?.comments.filter((comment) => !!comment.path) ?? EMPTY_COMMENTS,
    [details?.comments]
  )

  const prHeadSha = details?.headSha
  // Why: consumers key expensive anchoring memos off this object; a fresh
  // reference every render would recompute them on unrelated re-renders.
  return useMemo(
    () => ({
      comments,
      prNumber: detailsCacheKey ? prNumber : null,
      repoId: detailsCacheKey ? repoId : null,
      repoPath: detailsCacheKey ? repoPath : null,
      prHeadSha
    }),
    [comments, detailsCacheKey, prHeadSha, prNumber, repoId, repoPath]
  )
}
