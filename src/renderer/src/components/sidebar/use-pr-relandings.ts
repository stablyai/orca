import { useEffect, useState } from 'react'
import type { RelandedPullRequestSummary } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { fetchPRRelandings } from '@/store/github/pr-relandings-lookup'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

/** Looks up where a closed, unmerged GitHub PR's work landed; undefined for any other review. */
export function usePRRelandings(
  repo: Repo | undefined,
  review: WorktreeCardPrDisplay | null
): RelandedPullRequestSummary[] | undefined {
  const prNumber = review?.provider === 'github' && review.state === 'closed' ? review.number : null
  const githubRepository = review && 'githubRepository' in review ? review.githubRepository : null
  const prOwner = githubRepository?.owner ?? null
  const prRepoName = githubRepository?.repo ?? null
  const prHost = githubRepository?.host ?? null
  const key = repo && prNumber ? `${repo.id}#${prHost}/${prOwner}/${prRepoName}#${prNumber}` : ''
  const [result, setResult] = useState<{ key: string; data: RelandedPullRequestSummary[] }>()

  useEffect(() => {
    if (!repo || !prNumber) {
      return
    }
    let cancelled = false
    // Why: keep the host, or a GitHub Enterprise PR falls back to the origin's host.
    const prRepo =
      prOwner && prRepoName
        ? { owner: prOwner, repo: prRepoName, ...(prHost ? { host: prHost } : {}) }
        : null
    void fetchPRRelandings(useAppStore.getState(), repo, prNumber, prRepo).then((data) => {
      if (!cancelled) {
        setResult({ key, data })
      }
    })
    return () => {
      cancelled = true
    }
  }, [repo, prNumber, prOwner, prRepoName, prHost, key])

  return key && result?.key === key ? result.data : undefined
}
