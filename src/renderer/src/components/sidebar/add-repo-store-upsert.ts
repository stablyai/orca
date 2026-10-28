import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { adoptFromEndpoint } from '@/store/adopt-from-endpoint'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { awaitRepoOwnerHostKnown } from '@/store/repos/repo-owner-host-readiness'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

type AddedRepoOwner = {
  /** The endpoint the add was sent to; the row it returned names its own owner. */
  runtimeEnvironmentId?: string | null
}

export async function upsertAddedRepoWithProjectHostSetup(
  repo: Repo,
  owner: AddedRepoOwner = {}
): Promise<{ alreadyPresent: boolean; repo: Repo }> {
  const state = useAppStore.getState()
  // Why adopt rather than stamp the picked host: this app may answer with a repo another host owns
  // (a WSL path is added on its distro's server), and that owner is the one to route to.
  const ownedRepo =
    owner.runtimeEnvironmentId === undefined
      ? repo
      : adoptFromEndpoint(runtimeTargetForOwnerEnvironment(owner.runtimeEnvironmentId), {
          kind: 'repo',
          row: repo
        })
  const repoIdentity = getRepoHostIdentity(ownedRepo)
  const alreadyPresent = state.repos.some((entry) => getRepoHostIdentity(entry) === repoIdentity)
  const repos = alreadyPresent
    ? state.repos.map((entry) => (getRepoHostIdentity(entry) === repoIdentity ? ownedRepo : entry))
    : [...state.repos, ownedRepo]
  const projection = projectHostSetupProjectionFromRepos(repos)

  // Direct IPC bypasses repo-slice compatibility projection; synchronize project-first state here.
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  await awaitRepoOwnerHostKnown(useAppStore.getState, ownedRepo)
  return { alreadyPresent, repo: ownedRepo }
}
