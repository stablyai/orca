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

/**
 * Does this record's `--resume` locator belong to a different machine than the one the resume would
 * run on?
 *
 * A provider session id names a transcript in one machine's agent state directory, but nothing
 * else in the resume path is host-scoped: `worktreeId` is `repoId::path` with no host component
 * (shared/worktree/host-qualified-identity.ts), sleeping records are `'sleepingAgentKeyed'` so the
 * boot-time host-contention parking never arbitrates them and every partition's records merge into
 * one map, and `launchSleepingAgentSession` resolves its launch target from the *current* catalog.
 * A record captured on host A therefore reaches a launch on host B, which answers
 * `No conversation found with session ID`.
 *
 * Deliberately fails open. It reports only a positively-known disagreement about the machine,
 * because the alternative — refusing whenever the hosts cannot be compared — would strand every
 * legitimate resume whose capture predates the stamp.
 *
 * "Fail open" names a direction for THIS decision, never a house style, and the safe direction is
 * inverted a few files away. Here the destructive act is *attempting* a resume — a wrong one can
 * fork a transcript, which is unrecoverable, while a refusal keeps the record and the user can
 * resume by hand. So an unhydrated catalog must not be read as a host verdict. In
 * `workspace-session-terminal-buffers.ts` the destructive act is the opposite: declining to capture
 * loses the only scrollback copy, so an unknown repo is treated as remote. Same window, opposite
 * default, both correct. A reader pattern-matching one onto the other will get this backwards.
 *
 * The four unknowns this fails open on:
 *
 *  - `undefined` is "never stamped", not "local" (#9030 leaves SSH orphans unstamped).
 *  - `null` is "local **or** paired runtime": a `remote:<env>@@<handle>` PTY is stamped null too
 *    (agent-status-connection-ownership.ts), so null cannot rule a runtime host out — only an
 *    `ssh:` one, which is unambiguously another machine.
 *  - A current host of `runtime:*` is no evidence either way, because a paired client relabels its
 *    host's workspaces — including that host's own SSH ones — into its runtime namespace.
 *  - A current host of `null` is a catalog with no row for the worktree. The routing resolver
 *    answers `'local'` there, which is the right default for issuing an operation and would read
 *    here as a positive host — so the worktree form below asks the resolver that keeps the silence.
 */
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

// Why owner rows only: two records' machines are a property of their own workspaces, never of the
// focused server, so this reads no routing default and an unknown owner stays unknown.
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

/**
 * May `claimant`'s pane stand in for `record`'s session? Locators are machine-scoped, so not when the
 * claimant's host moved since capture (it could not resume the session either), nor when the two
 * records positively name different machines, even with matching ids (a copied state dir). Fails
 * open on the same unknowns as above: only known disagreement blocks the claim.
 */
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
