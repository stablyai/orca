import { getRepoExecutionHostId } from './execution-host'
import type { ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { WorktreeMeta } from './worktree/meta-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'

export function getProjectHostSetupForRepo(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): ProjectHostSetup {
  // A repo id can exist on multiple hosts; the host-qualified setup is authoritative.
  const executionHostId = getRepoExecutionHostId(repo)
  return (
    setups.find((setup) => setup.repoId === repo.id && setup.hostId === executionHostId) ??
    setups.find((setup) => setup.repoId === repo.id) ??
    projectHostSetupProjectionFromRepos([repo]).setups[0]
  )
}

export function getProjectHostSetupWorktreeMeta(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'> {
  const setup = getProjectHostSetupForRepo(setups, repo)
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id
  }
}
