import type { TaskPageGitHubSearchPaginationModel } from './use-task-page-github-search-pagination'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { sortWorkItemsByNumber } from '../../../../../shared/work-items'

export function readTaskPageGitHubLandingCache(
  {
    selectedRepos,
    getCachedWorkItems,
    githubPerRepoPageLimit,
    githubPageSize
  }: Pick<
    TaskPageGitHubSearchPaginationModel,
    'selectedRepos' | 'getCachedWorkItems' | 'githubPerRepoPageLimit' | 'githubPageSize'
  >,
  q: string
) {
  const preMerged: GitHubWorkItem[] = []
  let anyUncached = false
  let anyRepoCached = false
  for (const r of selectedRepos) {
    const cached = getCachedWorkItems(
      r.id,
      githubPerRepoPageLimit,
      q,
      r.path,
      getTaskPageRepoSourceContext(r, 'github')
    )
    if (cached === null) {
      anyUncached = true
    } else {
      anyRepoCached = true
      preMerged.push(...cached)
    }
  }
  // Why: page-one metadata and the restored numbered page have independent lifecycles.
  const page0Raw =
    preMerged.length > 0 ? sortWorkItemsByNumber(preMerged).slice(0, githubPageSize) : []

  return { page0Raw, anyUncached, anyRepoCached }
}

export function countTaskPageGitHubLandingPages(
  model: TaskPageGitHubSearchPaginationModel,
  q: string,
  onCounted: (result: { totalPages: number }) => void,
  options?: { wakeWslDistro?: boolean }
): void {
  void model
    .countWorkItemsAcrossRepos(
      model.selectedRepos.map((r) => ({
        repoId: r.id,
        path: r.path,
        executionHostId: r.executionHostId,
        sourceContext: getTaskPageRepoSourceContext(r, 'github')
      })),
      q,
      model.githubPerRepoPageLimit,
      options
    )
    .then(onCounted)
}
