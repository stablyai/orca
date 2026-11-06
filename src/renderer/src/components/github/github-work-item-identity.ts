import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import { parseGitHubItemRepository } from '../../../../shared/github/work-item-target'
export { parseGitHubItemRepository as parseOwnerRepoFromItemUrl } from '../../../../shared/github/work-item-target'

/** Project rows may belong to another repo; route mutations by their slug instead of the active workspace. */
export type GitHubWorkItemProjectOrigin = {
  owner: string
  repo: string
  /** GitHub host (e.g. GHES); absent means github.com. */
  host?: string
  number: number
  type: 'issue' | 'pr'
  projectId: string
  projectItemId: string
  cacheKey: string
}

// Pin the GitHub host for every PR mutation so process GH_HOST cannot redirect the item.
export function resolvePullRequestRepo(
  item: Pick<GitHubWorkItem, 'prRepo' | 'url'>,
  projectOrigin?: Pick<GitHubWorkItemProjectOrigin, 'owner' | 'repo' | 'host'>
): GitHubOwnerRepo | null {
  const repo =
    item.prRepo ??
    (projectOrigin
      ? {
          owner: projectOrigin.owner,
          repo: projectOrigin.repo,
          host: projectOrigin.host
        }
      : null) ??
    parseGitHubItemRepository(item.url)
  return repo ? { ...repo, host: githubProjectHost(repo.host) } : null
}

export type ItemDialogTab = 'conversation' | 'checks' | 'files'

export function normalizeItemDialogTab(
  item: GitHubWorkItem | null,
  tab: ItemDialogTab | undefined
): ItemDialogTab {
  if (item?.type !== 'pr') {
    return 'conversation'
  }
  return tab ?? 'conversation'
}
