import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import type { AppState } from '../types'

type HostCatalogState = Pick<
  AppState,
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'setRuntimeEnvironments'
  | 'readRuntimeHostStatusSnapshots'
>

/** Lists the hosts main knows and reads their last status, without probing or waking any. */
export async function readRuntimeHostCatalog(state: HostCatalogState): Promise<void> {
  state.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  await state.readRuntimeHostStatusSnapshots()
}

/** A first Add can return a newly paired host; a failed catalog read must not fail the saved add. */
export async function awaitRepoOwnerHostKnown(
  getState: () => HostCatalogState,
  repo: { executionHostId?: string | null; connectionId?: string | null }
): Promise<void> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind !== 'runtime') {
    return
  }
  try {
    const state = getState()
    const listed = state.runtimeEnvironments.some((entry) => entry.id === host.environmentId)
    const answered = lastVerifiedRuntimeStatus(
      state.runtimeStatusByEnvironmentId.get(host.environmentId)
    )
    if (!listed || !answered) {
      await readRuntimeHostCatalog(state)
    }
  } catch (error) {
    console.warn('[add-project] could not read the new project host', error)
  }
}

/** A failed multi-method registration can still have saved a usable row on its owner. */
export async function refreshWslRegistrationAfterFailure(
  getState: () => AppState,
  path: string
): Promise<void> {
  const parsed = parseWslUncPath(path)
  if (
    !parsed ||
    !getState().settings?.experimentalWslHosts ||
    !window.api.runtimeEnvironments?.wslHosts
  ) {
    return
  }
  try {
    await readRuntimeHostCatalog(getState())
  } catch (error) {
    console.warn('[add-project] could not read the partial registration owner', error)
  }
  const environment = getState().runtimeEnvironments.find(
    (row) =>
      row.orcadDeployment?.kind === 'wsl' &&
      row.orcadDeployment.distro.toLowerCase() === parsed.distro.toLowerCase()
  )
  if (!environment) {
    return
  }
  try {
    await getState().fetchRepos({ runtimeEnvironmentId: environment.id })
  } catch (error) {
    console.warn('[add-project] could not refresh a partial WSL registration', error)
  }
}
