import {
  getRepoExecutionHostIdOrDefault,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from './execution-host'
import type { Repo } from './repo-types'

type HiddenRepoRow = Pick<Repo, 'id' | 'hiddenAt' | 'connectionId' | 'executionHostId'>

export function isRepoHidden(repo: Pick<Repo, 'hiddenAt'> | null | undefined): boolean {
  return typeof repo?.hiddenAt === 'number'
}

/** Hidden repo rows, host-qualified: hiding one host's copy leaves the others listed. */
export type HiddenRepoRows = {
  readonly size: number
  has: (repoId: string, hostId: ExecutionHostId | null) => boolean
}

export const NO_HIDDEN_REPO_ROWS: HiddenRepoRows = { size: 0, has: () => false }

const cache = new WeakMap<
  readonly HiddenRepoRow[],
  { defaultHostId: ExecutionHostId; rows: HiddenRepoRows }
>()

const rowKey = (repoId: string, hostId: ExecutionHostId): string => `${hostId}\0${repoId}`

/** Unstamped rows belong to `defaultHostId`, as the sidebar's host resolution reads them. */
export function indexHiddenRepoRows(
  repos: readonly HiddenRepoRow[],
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): HiddenRepoRows {
  const cached = cache.get(repos)
  if (cached?.defaultHostId === defaultHostId) {
    return cached.rows
  }
  const keys = new Set<string>()
  for (const repo of repos) {
    if (isRepoHidden(repo)) {
      keys.add(rowKey(repo.id, getRepoExecutionHostIdOrDefault(repo, defaultHostId)))
    }
  }
  const rows: HiddenRepoRows =
    keys.size === 0
      ? NO_HIDDEN_REPO_ROWS
      : {
          size: keys.size,
          has: (repoId, hostId) => hostId !== null && keys.has(rowKey(repoId, hostId))
        }
  cache.set(repos, { defaultHostId, rows })
  return rows
}

/** The row-filter fact: whether a row's own host copy of its project is hidden. */
export function hiddenProjectRowFact<Row extends { repoId: string }>(
  hidden: HiddenRepoRows,
  hostIdOf: (row: Row) => ExecutionHostId | null
): (row: Row) => boolean {
  return hidden.size === 0 ? () => false : (row) => hidden.has(row.repoId, hostIdOf(row))
}

/** Drops hidden rows; returns the same array when nothing is hidden so memoized readers stay stable. */
export function withoutHiddenRepos<R extends Pick<Repo, 'hiddenAt'>>(
  repos: readonly R[]
): readonly R[] {
  return repos.some(isRepoHidden) ? repos.filter((repo) => !isRepoHidden(repo)) : repos
}
