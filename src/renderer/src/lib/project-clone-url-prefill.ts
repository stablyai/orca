import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

/**
 * The clone URL to seed "Clone from URL" with, taken from the project's own
 * remote so the common case is one click.
 *
 * Credentials are stripped: the stored value is the verbatim `git remote` URL
 * and can embed a PAT, while the clone runs on the *target* host and would write
 * that token into its `.git/config` — a credential the user never typed into
 * this flow. Same treatment `getProvisionedRootRecipeRepoUrl` gives the
 * ephemeral-VM recipe URL.
 */
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
