import { getRepoExecutionHostId } from './execution-host'
import { getRepoHostIdentityForParts } from './repo-host-identity'
import type { Repo } from './repo-types'
import type { ProjectSectionRepo, ProjectGroupingIndex } from './project-section-grouping'

export type ProjectHeaderRevealTarget<
  R extends Pick<ProjectSectionRepo, 'displayName'> & Partial<ProjectSectionRepo> = Repo
> = {
  key: string
  label: string
  repo?: R
  projectId?: string
}

const sectionRepoLookups = new WeakMap<
  readonly ProjectSectionRepo[],
  ReadonlyMap<string, ProjectSectionRepo>
>()
export function getProjectSectionRepoLookup<R extends ProjectSectionRepo>(
  repos: readonly R[]
): ReadonlyMap<string, R> {
  let cached = sectionRepoLookups.get(repos)
  if (!cached) {
    cached = new Map(
      repos.map((repo) => [
        getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)),
        repo
      ])
    )
    sectionRepoLookups.set(repos, cached)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each immutable array owns only the R values passed on its first lookup.
  return cached as ReadonlyMap<string, R>
}

export function getProjectGroupingForRepo<
  R extends Pick<ProjectSectionRepo, 'displayName'> & Partial<ProjectSectionRepo>
>(
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  hostId?: string,
  repoByHost?: ReadonlyMap<string, R>
): ProjectHeaderRevealTarget<R> {
  const separator = repoId.indexOf('\0')
  if (separator !== -1) {
    hostId = repoId.slice(0, separator)
    repoId = repoId.slice(separator + 1)
  }
  const rawRepo = repoMap.get(repoId)
  const repo = hostId
    ? (repoByHost?.get(`${hostId}\0${repoId}`) ??
      (rawRepo && getRepoExecutionHostId(rawRepo) === hostId ? rawRepo : undefined))
    : rawRepo
  const repoHost = hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  const identity = `${repoHost}\0${repoId}`
  const setup =
    projectIndex?.setupByRepoHost.get(identity) ??
    (hostId ? undefined : projectIndex?.setupByRepoId.get(repoId))
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  const group =
    projectIndex?.groupByRepoHost.get(identity) ??
    (hostId ? undefined : projectIndex?.groupByRepoId.get(repoId))
  return {
    key: group?.key ?? `project:${project.id}`,
    label: group?.label ?? project.displayName,
    repo,
    projectId: project.id
  }
}
