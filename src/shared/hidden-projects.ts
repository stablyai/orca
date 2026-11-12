import {
  getRepoExecutionHostIdOrDefault,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { Repo } from './repo-types'

type HiddenRepoRow = Pick<Repo, 'id' | 'hiddenAt' | 'connectionId' | 'executionHostId'>

/** A workspace row as the hidden-project check reads it; `hostId` is its own stamp, if any. */
export type HiddenProjectRowRef = { repoId: string; hostId?: string | null }

export function isRepoHidden(repo: Pick<Repo, 'hiddenAt'> | null | undefined): boolean {
  return typeof repo?.hiddenAt === 'number'
}

/** Hidden projects, host-qualified: hiding one host's copy leaves the others listed. */
export type HiddenProjects = {
  readonly any: boolean
  /** The row's own host copy is hidden. */
  isRowHidden: (row: HiddenProjectRowRef) => boolean
  /** Every copy of the project is hidden, so nothing of it is listed (stale filter ids). */
  isProjectHidden: (repoId: string) => boolean
}

export const NO_HIDDEN_PROJECTS: HiddenProjects = {
  any: false,
  isRowHidden: () => false,
  isProjectHidden: () => false
}

const cache = new WeakMap<
  readonly HiddenRepoRow[],
  { defaultHostId: ExecutionHostId; hidden: HiddenProjects }
>()

const rowKey = (repoId: string, hostId: ExecutionHostId): string => `${hostId}\0${repoId}`

/**
 * The one "is this row's project hidden" check. Unstamped repos belong to `defaultHostId`; an
 * unstamped row belongs to its project's only copy, else to `defaultHostId`, never to whichever
 * copy a bare-id lookup happens to return.
 */
export function indexHiddenProjects(
  repos: readonly HiddenRepoRow[],
  defaultHostId: ExecutionHostId
): HiddenProjects {
  const cached = cache.get(repos)
  if (cached?.defaultHostId === defaultHostId) {
    return cached.hidden
  }
  const hiddenKeys = new Set<string>()
  const hostsByRepoId = new Map<string, ExecutionHostId[]>()
  const listedRepoIds = new Set<string>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostIdOrDefault(repo, defaultHostId)
    const hosts = hostsByRepoId.get(repo.id)
    if (hosts) {
      hosts.push(hostId)
    } else {
      hostsByRepoId.set(repo.id, [hostId])
    }
    if (isRepoHidden(repo)) {
      hiddenKeys.add(rowKey(repo.id, hostId))
    } else {
      listedRepoIds.add(repo.id)
    }
  }
  const hidden: HiddenProjects =
    hiddenKeys.size === 0
      ? NO_HIDDEN_PROJECTS
      : {
          any: true,
          isRowHidden: (row) => {
            const hosts = hostsByRepoId.get(row.repoId)
            const hostId =
              normalizeExecutionHostId(row.hostId) ??
              (hosts?.length === 1 ? hosts[0] : defaultHostId)
            return hostId !== undefined && hiddenKeys.has(rowKey(row.repoId, hostId))
          },
          isProjectHidden: (repoId) => hostsByRepoId.has(repoId) && !listedRepoIds.has(repoId)
        }
  cache.set(repos, { defaultHostId, hidden })
  return hidden
}

/** Drops hidden rows; returns the same array when nothing is hidden so memoized readers stay stable. */
export function withoutHiddenRepos<R extends Pick<Repo, 'hiddenAt'>>(
  repos: readonly R[]
): readonly R[] {
  return repos.some(isRepoHidden) ? repos.filter((repo) => !isRepoHidden(repo)) : repos
}

/** Filter ids whose every copy is hidden select nothing visible; drop them rather than show an empty list. */
export function withoutHiddenFilterRepoIds(
  filterRepoIds: readonly string[],
  hidden: HiddenProjects
): readonly string[] {
  return hidden.any && filterRepoIds.some(hidden.isProjectHidden)
    ? filterRepoIds.filter((id) => !hidden.isProjectHidden(id))
    : filterRepoIds
}

/** The two row-filter facts every workspace list reads, from the one shared check. */
export function hiddenProjectRowFacts(hidden: HiddenProjects): {
  isInHiddenProject: (row: HiddenProjectRowRef) => boolean
  isProjectHidden: (repoId: string) => boolean
} {
  return { isInHiddenProject: hidden.isRowHidden, isProjectHidden: hidden.isProjectHidden }
}

/** A picker's list: hidden projects drop out, except the one already chosen, so an explicit target still shows. */
export function pickerRepos<R extends Pick<Repo, 'id' | 'hiddenAt'>>(
  repos: readonly R[],
  chosenRepoId?: string | null
): readonly R[] {
  return repos.some(isRepoHidden)
    ? repos.filter((repo) => !isRepoHidden(repo) || repo.id === chosenRepoId)
    : repos
}
