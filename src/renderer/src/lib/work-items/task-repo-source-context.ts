import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitLabProjectRef } from '../../../../shared/gitlab/gitlab-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/work-items/task-source-context'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project/host-setup/project-host-setup-projection'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
/** Where a Gitea item lives: the server's web origin plus owner/repo, read from the item itself. */
export type GiteaItemRepoRef = { url: string; repoOwner: string; repoName: string }

export function getTaskPageRepoSourceContext(
  repo: Repo | null | undefined,
  provider: 'github' | 'gitlab' | 'gitea',
  providerRef?: GitLabProjectRef | GiteaItemRepoRef | null
): TaskSourceContext | null {
  if (!repo) {
    return null
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects[0]
  const setup = projection.setups[0]
  const providerIdentity =
    provider === 'github' && project?.providerIdentity?.provider === 'github'
      ? project.providerIdentity
      : provider === 'gitlab' && providerRef && 'path' in providerRef
        ? buildGitLabProviderIdentity(providerRef)
        : provider === 'gitea' && providerRef && 'repoOwner' in providerRef
          ? buildGiteaProviderIdentity(providerRef)
          : null
  return normalizeTaskSourceContext({
    provider,
    projectId: setup?.projectId ?? project?.id ?? repo.id,
    hostId: setup?.hostId ?? getRepoExecutionHostId(repo),
    projectHostSetupId: setup?.id,
    repoId: repo.id,
    providerIdentity
  })
}
export function buildGiteaProviderIdentity(ref: GiteaItemRepoRef) {
  const marker = `/${ref.repoOwner}/${ref.repoName}/`
  const index = ref.url.toLowerCase().indexOf(marker.toLowerCase())
  return {
    provider: 'gitea' as const,
    baseUrl: index > 0 ? ref.url.slice(0, index) : null,
    owner: ref.repoOwner,
    repo: ref.repoName
  }
}
export function buildGitLabProviderIdentity(projectRef: GitLabProjectRef) {
  const pathParts = projectRef.path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const projectName = pathParts.at(-1) ?? null
  const namespace = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null
  return {
    provider: 'gitlab' as const,
    projectId: projectRef.path,
    namespace,
    project: projectName,
    webUrl: `https://${projectRef.host}/${projectRef.path}`
  }
}
