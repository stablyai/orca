import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { parseOwnerRepoFromItemUrl } from '@/components/github/github-work-item-identity'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { PER_REPO_FETCH_LIMIT } from '../../../../../shared/work-items'

// Recover the PR slug from this repo’s cache only; sibling forks may share an issue source but differ in PR origin.
export function WorkItemIssueSourceIndicator({
  url,
  repoId,
  repoPath
}: {
  url: string
  repoId: string | null
  repoPath?: string | null
}): React.JSX.Element | null {
  // Sources are repo-level; query-keyed sibling entries are safe when the primary cache slot is absent.
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
