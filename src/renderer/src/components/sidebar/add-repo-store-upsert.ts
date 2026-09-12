import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'

type AddedRepoOwner = {
  runtimeEnvironmentId?: string | null
  sshConnectionId?: string | null
}

function repoWithCapturedOwner(repo: Repo, owner: AddedRepoOwner): Repo {
  const sshConnectionId = owner.sshConnectionId?.trim()
  if (sshConnectionId) {
    return { ...repo, executionHostId: toSshExecutionHostId(sshConnectionId) }
  }
  if (owner.runtimeEnvironmentId !== undefined) {
    const runtimeEnvironmentId = owner.runtimeEnvironmentId?.trim()
    return {
      ...repo,
      executionHostId: runtimeEnvironmentId
        ? toRuntimeExecutionHostId(runtimeEnvironmentId)
        : LOCAL_EXECUTION_HOST_ID
    }
  }
  return repo
}

export function upsertAddedRepoWithProjectHostSetup(
  repo: Repo,
  owner: AddedRepoOwner = {}
): { alreadyPresent: boolean; repo: Repo } {
  const state = useAppStore.getState()
  const ownedRepo = repoWithCapturedOwner(repo, owner)
  const repoIdentity = getRepoHostIdentity(ownedRepo)
  const alreadyPresent = state.repos.some((entry) => getRepoHostIdentity(entry) === repoIdentity)
  const repos = alreadyPresent
    ? state.repos.map((entry) => (getRepoHostIdentity(entry) === repoIdentity ? ownedRepo : entry))
    : [...state.repos, ownedRepo]
  const projection = projectHostSetupProjectionFromRepos(repos)

  // Why: these Add Project flows call IPC directly, bypassing the repo slice
  // action that normally keeps the project-first compatibility model synced.
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  return { alreadyPresent, repo: ownedRepo }
}
