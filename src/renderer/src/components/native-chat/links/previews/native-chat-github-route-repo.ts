import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import { readRepoSlugCache, repoSlugCacheKey } from '@/lib/workspace/catalog/repo-slug-cache'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  authorityKey,
  parseHostAuthorityKey,
  type HostAuthorityKey
} from '../../../../../../shared/host-authority'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey,
  repoUpstreamIdentityKey
} from '../../../../../../shared/github/repositories/repository-identity-key'

export type RepoWithOriginKey = { repo: Repo; originKey: string | null }

export function githubPreviewRepoAuthorityKey(repo: Repo): HostAuthorityKey | null {
  const authority = parseHostAuthorityKey(getRepoExecutionHostId(repo))
  if (!authority) {
    return null
  }
  const connectionId = getRepoSshConnectionId(repo)
  return authorityKey(
    authority.endpoint.kind === 'environment' && connectionId
      ? { ...authority, at: toSshExecutionHostId(connectionId) }
      : authority
  )
}

/** One registered route, including its endpoint, nested target and account binding. */
export function githubPreviewRepoIdentity(repo: Repo): string {
  return JSON.stringify([
    githubPreviewRepoAuthorityKey(repo),
    repo.id,
    repo.path,
    repo.kind ?? 'git',
    repo.connectionId ?? null,
    repo.ghAccount?.host ?? null,
    repo.ghAccount?.user ?? null,
    repo.upstream ?? null,
    repo.gitRemoteIdentity ?? null
  ])
}

/** Git repos on the chat's host; their remotes decide which GitHub sign-in a lookup may use. */
export function githubPreviewRouteCandidates(
  repos: readonly Repo[],
  routeAuthority: HostAuthorityKey
): Repo[] {
  return repos.filter(
    (repo) =>
      (!repo.kind || repo.kind === 'git') && githubPreviewRepoAuthorityKey(repo) === routeAuthority
  )
}

export function readGitHubPreviewRouteRepo(
  repos: readonly Repo[],
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink
): Repo | null {
  return pickGitHubPreviewRouteRepo(
    githubPreviewRouteCandidates(repos, routeAuthority).map((repo) => {
      const key = repoSlugCacheKey(repo)
      const slug = key ? readRepoSlugCache(key) : null
      return { repo, originKey: slug?.hit ? slug.value : null }
    }),
    link
  )
}

/** The repo to ask about a link when the chat has no repo on its GitHub host: the linked repo's own
 *  clone first, else any repo with a remote on that host, whose sign-in main lets a preview use. */
export function pickGitHubPreviewRouteRepo(
  candidates: readonly RepoWithOriginKey[],
  link: GitHubIssueOrPRLink
): Repo | null {
  const linkKey = githubRepoIdentityKey(link.slug)
  const linkHost = githubHostFromIdentityKey(linkKey)
  let selected: Repo | null = null
  let rank = 3
  for (const { repo, originKey } of candidates) {
    const candidateRank = githubPreviewRouteRank(repo, originKey, linkKey, linkHost)
    if (candidateRank < rank) {
      selected = repo
      rank = candidateRank
    }
  }
  return selected
}

export function githubPreviewRouteRank(
  repo: Repo,
  originKey: string | null,
  linkKey: string,
  linkHost: string | undefined
): number {
  if (!originKey) {
    return 3
  }
  if (originKey === linkKey) {
    return 0
  }
  if (repoUpstreamIdentityKey(repo, originKey) === linkKey) {
    return 1
  }
  return githubHostFromIdentityKey(originKey) === linkHost ? 2 : 3
}

export async function findGitHubPreviewRouteRepo(
  repos: readonly Repo[],
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink
): Promise<Repo | null> {
  // Slugs are cached per repo, and the sidebar's slug index has usually resolved them already.
  const candidates = await Promise.all(
    githubPreviewRouteCandidates(repos, routeAuthority).map(async (repo) => ({
      repo,
      originKey: await resolveRepoSlug(repo)
    }))
  )
  return pickGitHubPreviewRouteRepo(candidates, link)
}
