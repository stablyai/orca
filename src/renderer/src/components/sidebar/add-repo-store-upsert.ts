import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { selectRepos } from '../../store/project-catalog-selectors'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { mainCatalogShowsWrite } from '@/store/main-project-catalog-writes'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

type AddedRepoOwner = {
  runtimeEnvironmentId?: string | null
}

function repoWithCapturedOwner(repo: Repo, owner: AddedRepoOwner): Repo {
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

/**
 * After an Add Project flow's own host call. `reposBefore` is the catalog from before that call:
 * switch-on, main's catalog may already show the new row by the time the call answers.
 */
export async function upsertAddedRepoWithProjectHostSetup(
  repo: Repo,
  owner: AddedRepoOwner = {},
  reposBefore?: readonly Repo[]
): Promise<{ alreadyPresent: boolean; repo: Repo }> {
  const state = useAppStore.getState()
  const ownedRepo = repoWithCapturedOwner(repo, owner)
  const repoIdentity = getRepoHostIdentity(ownedRepo)
  const known = ORCA_SIDEBAR_INPUTS_IS_MAIN && reposBefore ? reposBefore : selectRepos(state)
  const alreadyPresent = known.some((entry) => getRepoHostIdentity(entry) === repoIdentity)
  // Switch point: main's catalog holds the row; the window waits for it instead of writing one.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    await mainCatalogShowsWrite(
      runtimeTargetForOwnerEnvironment(owner.runtimeEnvironmentId ?? null),
      (catalog) => catalog.repos.some((entry) => getRepoHostIdentity(entry) === repoIdentity)
    )
    return { alreadyPresent, repo: ownedRepo }
  }
  const repos = alreadyPresent
    ? selectRepos(state).map((entry) =>
        getRepoHostIdentity(entry) === repoIdentity ? ownedRepo : entry
      )
    : [...selectRepos(state), ownedRepo]
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
