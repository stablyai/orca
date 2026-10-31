import type { ProjectGroupingSettings } from '../../../shared/project-grouping'
import {
  buildRepoProjectGroupingIndex,
  getProjectGroupForRepo,
  type ProjectGroupingIndex
} from '../../../shared/project-section-grouping'
import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'
import type { Project } from '../../../shared/project-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'

const prefills = new WeakMap<ProjectGroupingIndex, Map<string, string>>()

type CloneSource = { repoId: string; hostId: string; path?: string | null }

export function selectProjectCloneUrlPrefill(
  state: AppState,
  projectId: string | null,
  source?: CloneSource
): string {
  if (!projectId) {
    return ''
  }
  const grouping = getProjectGroupingIndexFromState(state)
  let cached = prefills.get(grouping)
  if (!cached) {
    cached = new Map()
    prefills.set(grouping, cached)
  }
  const key = JSON.stringify([projectId, source])
  const existing = cached.get(key)
  if (existing !== undefined) {
    return existing
  }
  const value = resolveProjectCloneUrlPrefill(
    state.projects,
    state.repos,
    projectId,
    undefined,
    grouping,
    source
  )
  cached.set(key, value)
  return value
}

/** Seed from the project remote after stripping embedded credentials: target-host clone persists URLs to .git/config and must not receive an unentered PAT. Match getProvisionedRootRecipeRepoUrl. */
export function resolveProjectCloneUrlPrefill(
  projects: readonly Project[],
  repos: readonly Repo[],
  selectedProjectId: string | null,
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex,
  source?: CloneSource
): string {
  if (!selectedProjectId) {
    return ''
  }
  const projectIndex = selectedProjectId.startsWith('project:')
    ? (grouping ?? buildRepoProjectGroupingIndex(repos, settings))
    : null
  if (source) {
    const concrete = repos.find(
      (repo) =>
        repo.id === source.repoId &&
        getRepoExecutionHostId(repo) === source.hostId &&
        (!source.path || repo.path === source.path)
    )
    if (!concrete) {
      return ''
    }
    const member = projectIndex
      ? getProjectGroupForRepo(projectIndex, concrete)?.key === selectedProjectId
      : projects
          .find((project) => project.id === selectedProjectId)
          ?.sourceRepoIds.includes(concrete.id)
    return member ? stripCredentialsFromMessage(concrete.gitRemoteIdentity?.remoteUrl ?? '') : ''
  }
  if (projectIndex) {
    const members = repos.filter(
      (repo) => getProjectGroupForRepo(projectIndex, repo)?.key === selectedProjectId
    )
    return stripCredentialsFromMessage(
      members.find((repo) => repo.gitRemoteIdentity?.remoteUrl)?.gitRemoteIdentity?.remoteUrl ?? ''
    )
  }
  const sourceRepoIds =
    projects.find((candidate) => candidate.id === selectedProjectId)?.sourceRepoIds ?? []
  let reposById: Map<string, Repo> | undefined
  for (let index = 0; index < sourceRepoIds.length; index++) {
    if (index > 0 && !reposById) {
      reposById = new Map()
      for (const repo of repos) {
        const id = repo.id
        if (!reposById.has(id)) {
          reposById.set(id, repo)
        }
      }
    }
    const sourceId = sourceRepoIds[index]
    const source = reposById ? reposById.get(sourceId) : repos.find((repo) => repo.id === sourceId)
    const remoteUrl = source?.gitRemoteIdentity?.remoteUrl
    if (remoteUrl) {
      return stripCredentialsFromMessage(remoteUrl)
    }
  }
  return ''
}
