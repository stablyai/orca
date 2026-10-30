import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import type { WorkItemsCacheSources } from '@/store/slices/github'
import type { GitHubOwnerRepo } from '../../../../shared/types'

export type ComposerIssueSourceCandidates = {
  origin: GitHubOwnerRepo
  upstream: GitHubOwnerRepo
}

export function cacheKeyLooksLikeRepo(key: string, repoId: string): boolean {
  if (key.startsWith(`${repoId}::`)) {
    return true
  }
  // Host-scoped: `<hostId>::<repoId>::…` — match only host or repo segments, not query tails.
  const parts = key.split('::')
  return parts[0] === repoId || parts[1] === repoId
}

/**
 * Prefer a warm work-items cache entry that already carries origin/upstream
 * remote candidates (populated by listWorkItems). Used to show Upstream|Origin
 * on the New Workspace smart name field without an extra IPC (#9281).
 */
export function selectComposerIssueSourceCandidates(
  workItemsCache: Record<string, { sources?: WorkItemsCacheSources }>,
  repoId: string | null | undefined
): ComposerIssueSourceCandidates | null {
  if (!repoId) {
    return null
  }
  for (const [key, entry] of Object.entries(workItemsCache)) {
    if (!cacheKeyLooksLikeRepo(key, repoId)) {
      continue
    }
    const origin = entry.sources?.originCandidate
    const upstream = entry.sources?.upstreamCandidate
    if (!origin || !upstream) {
      continue
    }
    if (sameGitHubOwnerRepo(origin, upstream)) {
      continue
    }
    return { origin, upstream }
  }
  return null
}
