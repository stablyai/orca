/**
 * The one place a catalog row fetched from an endpoint gets its owner stamped. A row a paired
 * server returns is owned by that server (`runtime:E`); a row this app returns keeps the host it
 * names. Per-kind arms differ only in which fields carry that owner.
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { normalizeProjectHostSetupRow } from '../../../shared/project-catalog-row-normalization'
import type { RuntimeClientTarget } from '../runtime/runtime-client-target'
import { getRuntimeTargetHostId } from './runtime-target-host'

export type FetchedRepo = { kind: 'repo'; row: Repo }
export type FetchedProjectGroup = { kind: 'projectGroup'; row: ProjectGroup }
export type FetchedProjectHostSetup = { kind: 'projectHostSetup'; row: ProjectHostSetup }
export type FetchedFolderWorkspace = {
  kind: 'folderWorkspace'
  row: FolderWorkspace
  /** The row's own host on this app (explicit host, SSH connection, then its project group). */
  resolveOwnHostId: (workspace: FolderWorkspace) => ExecutionHostId
}
export type FetchedRow =
  | FetchedRepo
  | FetchedProjectGroup
  | FetchedProjectHostSetup
  | FetchedFolderWorkspace

export function adoptFromEndpoint(target: RuntimeClientTarget, fetched: FetchedRepo): Repo
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: FetchedProjectGroup
): ProjectGroup
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: FetchedProjectHostSetup
): ProjectHostSetup
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: FetchedFolderWorkspace
): FolderWorkspace
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: FetchedRow
): Repo | ProjectGroup | ProjectHostSetup | FolderWorkspace {
  switch (fetched.kind) {
    case 'repo':
      return adoptRepo(target, fetched.row)
    case 'projectGroup':
      return adoptProjectGroup(target, fetched.row)
    case 'projectHostSetup':
      return adoptProjectHostSetup(target, fetched.row)
    case 'folderWorkspace':
      return {
        ...fetched.row,
        executionHostId:
          target.kind === 'environment'
            ? getRuntimeTargetHostId(target)
            : fetched.resolveOwnHostId(fetched.row)
      }
  }
}

function adoptRepo(target: RuntimeClientTarget, repo: Repo): Repo {
  if (target.kind === 'environment') {
    // `connectionId` survives: on a server's row it names that server's nested SSH target.
    return { ...repo, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return repo.executionHostId ? repo : { ...repo, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

function adoptProjectGroup(target: RuntimeClientTarget, projectGroup: ProjectGroup): ProjectGroup {
  if (target.kind === 'environment') {
    return { ...projectGroup, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (projectGroup.connectionId) {
    return { ...projectGroup, executionHostId: toSshExecutionHostId(projectGroup.connectionId) }
  }
  return { ...projectGroup, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

function adoptProjectHostSetup(
  target: RuntimeClientTarget,
  setup: ProjectHostSetup
): ProjectHostSetup {
  // Why here: every setup row crossing IPC or RPC into the renderer passes through this
  // adoption step, so it is where the declared field types stop being aspirational.
  const adopted = normalizeProjectHostSetupRow(setup)
  if (target.kind !== 'environment') {
    return adopted
  }
  const hostId = getRuntimeTargetHostId(target)
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
