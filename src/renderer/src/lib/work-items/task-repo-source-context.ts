import type { Repo } from '../../../../shared/repo-types'
import type { GitLabProjectRef } from '../../../../shared/gitlab-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/work-items/task-source-context'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
/** Binds a repo or folder source to its project and host, retaining Backlog's source checkout path. */
export function getTaskPageRepoSourceContext(
  repo: Repo | null | undefined,
  provider: 'github' | 'gitlab' | 'backlog',
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
    providerIdentity:
      provider === 'backlog' ? { provider: 'backlog', projectPath: repo.path } : providerIdentity
  })
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
