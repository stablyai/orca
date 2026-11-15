import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { getProjectIdentityKey } from '../../../../../shared/project-host-setup-projection'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorkspaceCreationTargetHint } from './project-host-workspace-target'

export function getRepoWorkspaceCreationTargetHint(
  repo: Repo,
  projectHostSetups: readonly ProjectHostSetup[]
): WorkspaceCreationTargetHint {
  const hostId = getRepoExecutionHostId(repo)
  const setup = projectHostSetups.find(
    (candidate) => candidate.repoId === repo.id && candidate.hostId === hostId
  )
  return {
    projectId: setup?.projectId ?? getProjectIdentityKey(repo),
    hostId,
    ...(setup ? { projectHostSetupId: setup.id } : {})
  }
}
