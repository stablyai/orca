import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { parseOwnerRepoFromItemUrl } from '@/components/github/github-work-item-identity'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { PER_REPO_FETCH_LIMIT } from '../../../../../shared/work-items'

// Why: recover the PR-source slug the dialog lacks from workItemsCache, scoped to this repoPath so a sibling repo sharing the issue-source (e.g. two forks) can't mislabel the chip; hide when unknown rather than guess (design doc §1).
export function WorkItemIssueSourceIndicator({
  url,
  repoId,
  repoPath
}: {
  url: string
  repoId: string | null
  repoPath?: string | null
}): React.JSX.Element | null {
  // Why: resolve repo sources via the primary cache entry, or any sibling entry if the Tasks view only populated a query-keyed slot (sources are repo-level, so any is safe).
  const sources = useAppStore((s) =>
    s.getWorkItemsAnySourcesForRepo(repoId ?? '', PER_REPO_FETCH_LIMIT, repoPath ?? undefined)
  )
  const issues = useMemo<GitHubOwnerRepo | null>(() => {
    const fromUrl = parseOwnerRepoFromItemUrl(url)
    if (!fromUrl) {
      return null
    }
    // Prefer the cache's resolved issue-source (canonicalized by main) over the best-effort URL parse when they match.
    const cachedIssues = sources?.issues
    if (cachedIssues && sameGitHubOwnerRepo(cachedIssues, fromUrl)) {
      return cachedIssues
    }
    return fromUrl
  }, [url, sources])
  const prs = sources?.prs ?? null

  if (!issues || !prs || sameGitHubOwnerRepo(issues, prs)) {
    return null
  }
  return (
    <div className="mt-1">
      <IssueSourceIndicator issues={issues} prs={prs} variant="item" />
    </div>
  )
}
