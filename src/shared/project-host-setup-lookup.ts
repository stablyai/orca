import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
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
    setups.find(
      (setup) =>
        setup.repoId === repo.id &&
        setup.hostId === executionHostId &&
        (!repo.catalogOwnerHostId ||
          (setup.catalogOwnerHostId ?? setup.hostId) === repo.catalogOwnerHostId) &&
        (!repo.authoritativeExecutionHostId ||
          (setup.authoritativeExecutionHostId ?? setup.hostId) ===
            repo.authoritativeExecutionHostId)
    ) ?? projectHostSetupProjectionFromRepos([repo]).setups[0]
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

export function findProjectHostSetup(
  setups: readonly ProjectHostSetup[],
  selector: { setupId: string; executionHostId?: ExecutionHostId }
): ProjectHostSetup | undefined {
  const { setupId, executionHostId } = selector
  if (
    executionHostId !== undefined &&
    normalizeExecutionHostId(executionHostId) !== executionHostId
  ) {
    throw new Error('Invalid project setup execution host.')
  }
  const matches = setups.filter(
    (setup) =>
      setup.id === setupId && (executionHostId === undefined || setup.hostId === executionHostId)
  )
  if (matches.length > 1) {
    throw new Error(`Project host setup is ambiguous: ${setupId}. Specify its execution host.`)
  }
  return matches[0]
}
