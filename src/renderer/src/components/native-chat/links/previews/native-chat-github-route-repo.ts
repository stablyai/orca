import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey,
  repoUpstreamIdentityKey
} from '../../../../../../shared/github/repositories/repository-identity-key'

export type RepoWithOriginKey = { repo: Repo; originKey: string | null }

/** Git repos on the chat's host; their remotes decide which GitHub sign-in a lookup may use. */
export function githubPreviewRouteCandidates(repos: readonly Repo[], hostId: string): Repo[] {
  return repos.filter(
    (repo) => (!repo.kind || repo.kind === 'git') && getRepoExecutionHostId(repo) === hostId
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
  const resolved = candidates.filter((row): row is { repo: Repo; originKey: string } =>
    Boolean(row.originKey)
  )
  const clone = resolved.find(
    ({ repo, originKey }) =>
      originKey === linkKey || repoUpstreamIdentityKey(repo, originKey) === linkKey
  )
  return (
    clone?.repo ??
    resolved.find(({ originKey }) => githubHostFromIdentityKey(originKey) === linkHost)?.repo ??
    null
  )
}

export async function findGitHubPreviewRouteRepo(
  repos: readonly Repo[],
  hostId: string,
  link: GitHubIssueOrPRLink
): Promise<Repo | null> {
  // Slugs are cached per repo, and the sidebar's slug index has usually resolved them already.
  const candidates = await Promise.all(
    githubPreviewRouteCandidates(repos, hostId).map(async (repo) => ({
      repo,
      originKey: await resolveRepoSlug(repo)
    }))
  )
  return pickGitHubPreviewRouteRepo(candidates, link)
}
