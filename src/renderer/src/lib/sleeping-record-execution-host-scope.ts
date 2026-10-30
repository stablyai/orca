import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findFolderWorkspaceOwner,
  getExplicitRuntimeEnvironmentIdForFolderWorkspace,
  type FolderWorkspaceRuntimeOwnerState
} from './folder-workspace-runtime-owner'
import {
  findIndexedRepoOwner,
  findIndexedWorktreeOwner,
  findIndexedProjectGroupOwner,
  hasIndexedDetectedWorktree
} from './worktree-runtime-owner-index'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

/** Session locators are machine-scoped, while merged records/current-catalog routes can disagree with capture ownership. Block only known host disagreement; unknown legacy evidence must not strand resumes. Preserve four unknowns: undefined means unstamped (#9030); null means local or paired runtime and only excludes SSH; runtime:* relabels host/nested-SSH workspaces and proves no machine; null current owner means unhydrated catalog, never authoritative local. Wrong-host resume can fork irrecoverably, so preserve records and avoid guessing from routing defaults. This decision differs from workspace-session-terminal-buffers, where refusing unknown capture would lose the only scrollback copy. */
export function agentResumeOriginNamesAnotherExecutionHost(
  originConnectionId: string | null | undefined,
  currentExecutionHostId: ExecutionHostId | null | undefined
): boolean {
  if (originConnectionId === undefined) {
    return false
  }
  const originTargetId = originConnectionId === null ? null : originConnectionId.trim()
  if (originTargetId === '') {
    return false
  }
  const currentHost = parseExecutionHostId(currentExecutionHostId)
  if (!currentHost || currentHost.kind === 'runtime') {
    return false
  }
  if (currentHost.kind === 'ssh') {
    return originTargetId === null || toSshExecutionHostId(originTargetId) !== currentHost.id
  }
  return originTargetId !== null
}

/** The worktree-scoped form the activation sweep asks, resolving the host from the catalog. */
export function sleepingRecordNamesAnotherExecutionHost(
  record: SleepingAgentSessionRecord,
  state: WorktreeRuntimeOwnerState
): boolean {
  return agentResumeOriginNamesAnotherExecutionHost(
    record.connectionId,
    currentExecutionHostIdForRecord(record, state)
  )
}

type SleepingRecordOwnerState = WorktreeRuntimeOwnerState & FolderWorkspaceRuntimeOwnerState

// Current routing selection is identity evidence; a focused runtime is not.
function currentExecutionHostIdForRecord(
  record: SleepingAgentSessionRecord,
  state: SleepingRecordOwnerState
): ExecutionHostId | null {
  const worktreeId = record.worktreeId
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'local'
  }
  const activeHost =
    state.activeWorktreeId === worktreeId
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  if (activeHost) {
    return activeHost.id
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const environmentId = getExplicitRuntimeEnvironmentIdForFolderWorkspace(
      state,
      scope.folderWorkspaceId
    )
    if (environmentId) {
      return toRuntimeExecutionHostId(environmentId)
    }
    const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    if (!folder) {
      return null
    }
    if (
      !folder.executionHostId &&
      !folder.connectionId &&
      state.projectGroups?.some((group) => group.id === folder.projectGroupId) &&
      !findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
    ) {
      return null
    }
    return ownerExecutionHostIdForRecord(record, state) ?? 'local'
  }
  const resolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'resolved') {
    return (
      resolution.route.executionHostId ??
      (resolution.route.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(resolution.route.runtimeEnvironmentId)
        : null)
    )
  }
  if (
    resolution.kind === 'ambiguous' ||
    hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
  ) {
    return null
  }
  const worktree = findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  const repo = findIndexedRepoOwner(
    state.repos,
    worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  )
  return repo ? getRepoExecutionHostId(repo) : null
}

// Compare records’ own workspace owners, never focus/routing defaults; unknown ownership stays unknown.
function ownerExecutionHostIdForRecord(
  record: SleepingAgentSessionRecord,
  state: SleepingRecordOwnerState
): ExecutionHostId | null {
  const workspaceScope = parseWorkspaceKey(record.worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folder = findFolderWorkspaceOwner(state, workspaceScope.folderWorkspaceId)
    const group = folder?.projectGroupId
      ? findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
      : undefined
    const explicit = parseExecutionHostId(folder?.executionHostId ?? group?.executionHostId)?.id
    const connectionId = folder?.connectionId?.trim() || group?.connectionId?.trim()
    return explicit ?? (connectionId ? toSshExecutionHostId(connectionId) : null)
  }
  const worktree = findIndexedWorktreeOwner(state.worktreesByRepo, record.worktreeId)
  const worktreeHost = parseExecutionHostId(worktree?.hostId)?.id
  if (worktreeHost) {
    return worktreeHost
  }
  const repo = findIndexedRepoOwner(
    state.repos,
    worktree?.repoId ?? getRepoIdFromWorktreeId(record.worktreeId)
  )
  return repo && (repo.executionHostId?.trim() || repo.connectionId?.trim())
    ? getRepoExecutionHostId(repo)
    : null
}

// Why each side alone: either the owner row or the capture stamp can be the only evidence for a record.
function resolveSleepingRecordMachine(
  record: SleepingAgentSessionRecord,
  state: SleepingRecordOwnerState
): ExecutionHostId | null {
  const host = ownerExecutionHostIdForRecord(record, state)
  if (host && parseExecutionHostId(host)?.kind !== 'runtime') {
    return host
  }
  // A null stamp is "local or paired runtime", so only an SSH stamp names a machine.
  const stamp = record.connectionId?.trim()
  return stamp ? toSshExecutionHostId(stamp) : null
}

/** Claim only if neither claimant host movement nor known machine disagreement contradicts this locator. Equal IDs on copied state directories remain different sessions; unknown evidence stays allowed as above. */
export function sleepingRecordHostAllowsSessionClaim(
  claimant: SleepingAgentSessionRecord,
  record: SleepingAgentSessionRecord,
  state: SleepingRecordOwnerState
): boolean {
  if (
    agentResumeOriginNamesAnotherExecutionHost(
      claimant.connectionId,
      ownerExecutionHostIdForRecord(claimant, state)
    )
  ) {
    return false
  }
  const claimantMachine = resolveSleepingRecordMachine(claimant, state)
  const recordMachine = resolveSleepingRecordMachine(record, state)
  return claimantMachine === null || recordMachine === null || claimantMachine === recordMachine
}
