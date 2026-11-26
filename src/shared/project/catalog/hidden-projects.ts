import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostIdOrDefault,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'
import type { Repo } from '../../repository/repo-types'
import { getWorktreeIdFromHostIdentity } from '../../worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../workspace/identity/workspace-scope'

type HiddenRepoRow = Pick<Repo, 'id' | 'hiddenAt' | 'connectionId' | 'executionHostId'>

/** A workspace row as the hidden-project check reads it; `hostId` is its own stamp, if any. */
export type HiddenProjectRowRef = { repoId: string; hostId?: string | null }

/** The user's own Hide project toggle. Projects lists read `isRepoHiddenFromProjects`. */
export function isRepoHidden(repo: Pick<Repo, 'hiddenAt'> | null | undefined): boolean {
  return typeof repo?.hiddenAt === 'number'
}

type HostedRepoRow = Pick<Repo, 'hiddenAt' | 'connectionId' | 'executionHostId'>

// Hosts whose projects this window reaches but never lists: a shared agent's host, whose repos load
// only for its workers' workspace pages (design G8). Set by the window that knows them.
let projectsHiddenHosts: ReadonlySet<string> = new Set()
let projectsHiddenRevision = 0

/** Moves whenever the projects-hidden hosts change; caches of hidden-project reads key on it. */
export function projectsHiddenHostsRevision(): number {
  return projectsHiddenRevision
}

export function setProjectsHiddenHosts(hostIds: ReadonlySet<ExecutionHostId>): void {
  projectsHiddenHosts = hostIds
  projectsHiddenRevision += 1
}

/** Whether `hostId` is a host whose projects are never listed here (a shared agent's host). */
export function isProjectsHiddenHost(hostId: string | null | undefined): boolean {
  return !!hostId && projectsHiddenHosts.has(hostId)
}

/** Whether a repo is on a host whose projects are never listed here; false for unstamped repos. */
export function isRepoOnProjectsHiddenHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  hosts: ReadonlySet<string> = projectsHiddenHosts
) {
  return hosts.size > 0 && hosts.has(getRepoExecutionHostIdOrDefault(repo, LOCAL_EXECUTION_HOST_ID))
}

/** Whether the user hid every project they have; a shared host's projects are not theirs to show. */
export function everyUserProjectHidden(repos: readonly HostedRepoRow[]): boolean {
  const managed = userManagedRepos(repos)
  return managed.length > 0 && managed.every(isRepoHidden)
}

/** The one "kept out of Projects" check: hidden by the user, or on a host whose projects aren't listed. */
export function isRepoHiddenFromProjects(repo: HostedRepoRow | null | undefined): boolean {
  return !!repo && (isRepoHidden(repo) || isRepoOnProjectsHiddenHost(repo))
}

/** The repos this user configures here: never a projects-hidden host's (its owner's to manage). */
export function userManagedRepos<R extends Pick<Repo, 'connectionId' | 'executionHostId'>>(
  repos: readonly R[],
  hosts: ReadonlySet<string> = projectsHiddenHosts
): readonly R[] {
  const onHidden = (repo: R) => isRepoOnProjectsHiddenHost(repo, hosts)
  return repos.some(onHidden) ? repos.filter((repo) => !onHidden(repo)) : repos
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
  { defaultHostId: ExecutionHostId; revision: number; hidden: HiddenProjects }
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
  if (cached?.defaultHostId === defaultHostId && cached.revision === projectsHiddenRevision) {
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
    if (isRepoHidden(repo) || projectsHiddenHosts.has(hostId)) {
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
  cache.set(repos, { defaultHostId, revision: projectsHiddenRevision, hidden })
  return hidden
}

/** A row under a folder workspace is listed by that folder, so hiding its own project leaves it there (#43083). */
export function isListedByFolderWorkspace(
  identity: string,
  parentIdentityOf: (identity: string) => string | undefined
): boolean {
  const seen = new Set<string>()
  for (
    let parent = parentIdentityOf(identity);
    parent !== undefined && !seen.has(parent);
    parent = parentIdentityOf(parent)
  ) {
    if (parseWorkspaceKey(getWorktreeIdFromHostIdentity(parent))?.type === 'folder') {
      return true
    }
    seen.add(parent)
  }
  return false
}

/** Drops hidden rows; returns the same array when nothing is hidden so memoized readers stay stable. */
export function withoutHiddenRepos<R extends HostedRepoRow>(repos: readonly R[]): readonly R[] {
  return repos.some(isRepoHiddenFromProjects)
    ? repos.filter((repo) => !isRepoHiddenFromProjects(repo))
    : repos
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
export function pickerRepos<R extends Pick<Repo, 'id'> & HostedRepoRow>(
  repos: R[],
  chosenRepoId?: string | null
): R[]
export function pickerRepos<R extends Pick<Repo, 'id'> & HostedRepoRow>(
  repos: readonly R[],
  chosenRepoId?: string | null
): readonly R[]
export function pickerRepos<R extends Pick<Repo, 'id'> & HostedRepoRow>(
  repos: readonly R[],
  chosenRepoId?: string | null
): readonly R[] {
  return repos.some(isRepoHiddenFromProjects)
    ? repos.filter((repo) => !isRepoHiddenFromProjects(repo) || repo.id === chosenRepoId)
    : repos
}
