import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

/** Seed from the project remote after stripping embedded credentials: target-host clone persists URLs to .git/config and must not receive an unentered PAT. Match getProvisionedRootRecipeRepoUrl. */
export function resolveProjectCloneUrlPrefill(
  projects: readonly Project[],
  repos: readonly Repo[],
  selectedProjectId: string | null
): string {
  if (!selectedProjectId) {
    return ''
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
