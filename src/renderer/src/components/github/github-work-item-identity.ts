import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

// Why: the dialog lacks repository context, so recover its host-aware identity from the canonical item URL.
export function parseOwnerRepoFromItemUrl(url: string): GitHubOwnerRepo | null {
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.host) {
      return null
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    return { owner: segments[0], repo: segments[1], host: parsed.host }
  } catch {
    return null
  }
}

/** Why: a Project row may not belong to the active repo; when set, mutations route through slug-addressed IPCs against `owner`/`repo` so edits don't land on the workspace's repo. See docs/design/github-project-view-tasks.md §Dialog editing from Project rows. */
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

// Why: every PR mutation needs the same host-pinned identity so process GH_HOST
// cannot redirect a github.com item or a Project row to the wrong server.
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
    parseOwnerRepoFromItemUrl(item.url)
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
