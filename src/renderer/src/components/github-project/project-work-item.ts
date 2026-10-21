import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoHostTarget } from '../../../../shared/repo-host-identity'

export function buildProjectWorkItem(
  row: GitHubProjectRow,
  ownerRepo: RepoHostTarget,
  host?: string
): GitHubWorkItem | null {
  if (row.itemType !== 'ISSUE' && row.itemType !== 'PULL_REQUEST') {
    return null
  }
  if (row.content.number == null || !row.content.url) {
    return null
  }
  const [owner, repo] = row.content.repository?.split('/') ?? []
  // Why: Project rows can reach mutation controls before detail hydration, so
  // preserve their host-bearing repository identity on the initial item.
  const prRepo = owner && repo ? { owner, repo, host: githubProjectHost(host) } : undefined
  return {
    id: `${row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue'}:${row.content.number}`,
    type: row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue',
    number: row.content.number,
    title: row.content.title,
    state:
      row.content.state === 'MERGED'
        ? 'merged'
        : row.content.state === 'CLOSED'
          ? 'closed'
          : row.content.isDraft
            ? 'draft'
            : 'open',
    url: row.content.url,
    labels: row.content.labels.map((label) => label.name),
    updatedAt: row.updatedAt,
    author: null,
    repoId: ownerRepo.id,
    // Why: the slug matched this row; a twin id must not resolve the item to the other host's row.
    repoHostId: getRepoExecutionHostId(ownerRepo),
    prRepo
  }
}
