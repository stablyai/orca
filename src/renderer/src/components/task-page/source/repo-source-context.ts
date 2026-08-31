import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../../shared/project-host-setup-projection'
import {
  getTaskSourceCacheScope,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../shared/repo-types'

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

export function getTaskPageRepoSourceContext(
  repo: Repo | null | undefined,
  provider: 'github' | 'gitlab',
  gitlabProjectRef?: GitLabProjectRef | null
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
      : provider === 'gitlab' && gitlabProjectRef
        ? buildGitLabProviderIdentity(gitlabProjectRef)
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

export function getTaskPageRepoCacheInput(repo: Repo): {
  id: string
  path: string
  executionHostId?: string | null
  sourceCacheScope?: string | null
} {
  const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
  return {
    id: repo.id,
    path: repo.path,
    executionHostId: repo.executionHostId,
    sourceCacheScope:
      sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null
  }
}
