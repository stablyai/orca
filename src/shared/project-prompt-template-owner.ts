import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'

export function getProjectPromptTemplateOwner(
  project: Pick<Project, 'id' | 'sourceRepoIds'>,
  setups: readonly Pick<ProjectHostSetup, 'projectId' | 'hostId'>[],
  repos: readonly Repo[]
): ExecutionHostId | undefined {
  const hostIds = [
    ...setups.filter((setup) => setup.projectId === project.id).map((setup) => setup.hostId),
    ...repos
      .filter((repo) => project.sourceRepoIds.includes(repo.id) || repo.id === project.id)
      .map(getRepoExecutionHostId)
  ]
  let owner: ExecutionHostId | undefined
  for (const hostId of hostIds) {
    const host = parseExecutionHostId(hostId)
    if (host?.kind === 'local' || host?.kind === 'ssh') {
      return LOCAL_EXECUTION_HOST_ID
    }
    if (host?.kind === 'runtime' && (owner === undefined || host.id < owner)) {
      owner = host.id
    }
  }
  return owner
}
