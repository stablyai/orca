// The host stamp rows take entering a client's all-host catalog; shared so the phone matches the desktop.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from './execution-host'
import {
  normalizeProjectHostSetupRow,
  normalizeProjectHostSetupRows,
  normalizeProjectRows
} from './project-catalog-row-normalization'
import type { ProjectHostSetupProjection } from './project-host-setup-projection'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

export function adoptEndpointRepo(target: RuntimeClientTarget, repo: Repo): Repo {
  if (target.kind === 'environment') {
    // `connectionId` survives: on a server's row it names that server's nested SSH target.
    return { ...repo, executionHostId: toRuntimeExecutionHostId(target.environmentId) }
  }
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return repo.executionHostId ? repo : { ...repo, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

export function adoptEndpointProjectHostSetup(
  target: RuntimeClientTarget,
  setup: ProjectHostSetup
): ProjectHostSetup {
  // Why here: every setup row crossing IPC or RPC into a client passes through this
  // adoption step, so it is where the declared field types stop being aspirational.
  const adopted = normalizeProjectHostSetupRow(setup)
  if (target.kind !== 'environment') {
    return adopted
  }
  const hostId = toRuntimeExecutionHostId(target.environmentId)
  const executionHostId = adopted.executionHostId ?? adopted.hostId
  return {
    ...adopted,
    hostId,
    executionHostId: executionHostId === LOCAL_EXECUTION_HOST_ID ? hostId : executionHostId,
    runtimeOwnerEnvironmentId: target.environmentId,
    // Why: paired clients route through the HUB and must not treat its private SSH target as client-local configuration.
    connectionId: null
  }
}

/** An endpoint's `project.list` and `projectHostSetup.list` answers as a client's projection. */
export function adoptEndpointProjectCatalog(
  target: RuntimeClientTarget,
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[]
): ProjectHostSetupProjection {
  if (target.kind === 'local') {
    return {
      projects: normalizeProjectRows([...projects]),
      setups: normalizeProjectHostSetupRows([...setups])
    }
  }
  return {
    // Why projects too: the same wire response carries them, and a remote host on another
    // Orca version can publish a row whose declared field types do not hold.
    projects: normalizeProjectRows([...projects]),
    setups: setups.map((setup) => adoptEndpointProjectHostSetup(target, setup))
  }
}
