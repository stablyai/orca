/**
 * The one place a row or event from an endpoint gets its owner stamped. A row a paired server
 * returns is owned by that server (`runtime:E`); a row this app returns keeps the host it names.
 * Per-kind arms differ only in which fields carry that owner.
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
type WorktreeEventRow = {
  repoId: string
  renamed?: { oldWorktreeId: string; newWorktreeId: string }
}
/** A worktree change or activation an endpoint pushed; the endpoint is its only owner fact. */
export type EndpointWorktreeEvent = { kind: 'worktreeEvent'; row: WorktreeEventRow }
export type OwnedWorktreeEvent = WorktreeEventRow &
  (
    | { executionHostId: ExecutionHostId; forceLocalOwner?: never }
    | { executionHostId?: never; forceLocalOwner: true }
  )
/** A worktree an endpoint just created, stamped before any listing has seen it. */
export type CreatedWorktree = {
  kind: 'createdWorktree'
  /** The host the caller asked for; it wins, since the endpoint was derived from it. */
  requestedHostId: ExecutionHostId | undefined
  /** The repo's own host in this app's catalog. */
  resolveOwnHostId: () => ExecutionHostId
}
export type FetchedRow =
  | FetchedRepo
  | FetchedProjectGroup
  | FetchedProjectHostSetup
  | FetchedFolderWorkspace
  | EndpointWorktreeEvent
  | CreatedWorktree

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
  fetched: EndpointWorktreeEvent
): OwnedWorktreeEvent
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: CreatedWorktree
): ExecutionHostId
export function adoptFromEndpoint(
  target: RuntimeClientTarget,
  fetched: FetchedRow
): Repo | ProjectGroup | ProjectHostSetup | FolderWorkspace | OwnedWorktreeEvent | ExecutionHostId {
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
    case 'worktreeEvent':
      // Why: this app's own events can name any repo in its catalog (local or direct SSH), so they
      // pin the refresh to this app instead of to one host.
      return target.kind === 'environment'
        ? { ...fetched.row, executionHostId: getRuntimeTargetHostId(target) }
        : { ...fetched.row, forceLocalOwner: true }
    case 'createdWorktree':
      return (
        fetched.requestedHostId ??
        (target.kind === 'environment'
          ? getRuntimeTargetHostId(target)
          : fetched.resolveOwnHostId())
      )
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
