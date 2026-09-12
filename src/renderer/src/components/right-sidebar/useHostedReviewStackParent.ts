import { useEffect, useState } from 'react'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'

export type HostedReviewStackParent = Pick<HostedReviewInfo, 'number' | 'url'>

type FetchHostedReviewForBranch = (
  repoPath: string,
  branch: string,
  options?: { repoId?: string; active?: boolean }
) => Promise<HostedReviewInfo | null>

type UseHostedReviewStackParentOptions = {
  enabled: boolean
  repoPath: string
  repoId?: string | null
  base: string
  /**
   * The repo's own default branch — not the worktree's base. Stacking on the
   * repo default is meaningless, so that one case skips the lookup; every other
   * base still gets one, including the worktree base a child branch forked from
   * (the case stacking exists for).
   */
  repoDefaultBase?: string | null
  head: string
  fetchHostedReviewForBranch: FetchHostedReviewForBranch
}

type SettledLookup = {
  key: string
  review: HostedReviewStackParent | null
}

const LOOKUP_DEBOUNCE_MS = 300

export function useHostedReviewStackParent({
  enabled,
  repoPath,
  repoId,
  base,
  repoDefaultBase,
  head,
  fetchHostedReviewForBranch
}: UseHostedReviewStackParentOptions): HostedReviewStackParent | null {
  const normalizedBase = normalizeHostedReviewBaseRef(base).trim()
  const normalizedDefault = normalizeHostedReviewBaseRef(repoDefaultBase ?? '').trim()
  const normalizedHead = normalizeHostedReviewBaseRef(head).trim()
  const canLookup =
    enabled &&
    repoPath.length > 0 &&
    normalizedBase.length > 0 &&
    normalizedBase.toLowerCase() !== normalizedDefault.toLowerCase() &&
    normalizedBase.toLowerCase() !== normalizedHead.toLowerCase()
  const lookupKey = canLookup ? `${repoId ?? repoPath}:${normalizedBase}` : null
  const [settled, setSettled] = useState<SettledLookup | null>(null)

  useEffect(() => {
    if (!lookupKey) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchHostedReviewForBranch(repoPath, normalizedBase, {
        ...(repoId ? { repoId } : {}),
        active: true
      }).then(
        (review) => {
          if (cancelled) {
            return
          }
          const openGitHubReview =
            review?.provider === 'github' && (review.state === 'open' || review.state === 'draft')
              ? { number: review.number, url: review.url }
              : null
          setSettled({ key: lookupKey, review: openGitHubReview })
        },
        () => {
          if (!cancelled) {
            setSettled({ key: lookupKey, review: null })
          }
        }
      )
    }, LOOKUP_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fetchHostedReviewForBranch, lookupKey, normalizedBase, repoId, repoPath])

  return lookupKey && settled?.key === lookupKey ? settled.review : null
}
