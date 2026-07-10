import type { Repo, Worktree } from '../../../../shared/types'
import type { WorktreeGroupBy } from './worktree-list-groups'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  filterRepoIds: readonly string[]
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const filterSet = args.filterRepoIds.length > 0 ? new Set(args.filterRepoIds) : null
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (filterSet && !filterSet.has(repo.id)) {
      continue
    }
    if ((args.worktreesByRepo[repo.id]?.length ?? 0) === 0) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}
