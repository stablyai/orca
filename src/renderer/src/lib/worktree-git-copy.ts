import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { parseRoutableExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { getActiveWorkspaceExecutionHostId } from './active-workspace-host'
import {
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { GitPushTarget } from '../../../shared/worktree/types'
import { worktreeCopyOwnerKey } from '@/store/slices/worktrees/metadata/worktree-copy-review-clear'
import { runtimeTargetForWorkspaceOwner } from './resolve-owner'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from './connection-owner-resolution'

/**
 * One host's copy of a worktree, for git work whose answer is written back to the store. Worktree
 * ids are `repoId::path` and repeat across hosts, so the transport, the SSH target and the copy
 * the answer lands on must all come from this one resolution.
 */
export type WorktreeGitCopy = {
  readonly worktreeId: string
  /** The copy's host; null only when no row places it, which leaves a same-id twin untouched. */
  readonly hostId: ExecutionHostId | null
  readonly connectionId: string | undefined
  readonly transport: RuntimeClientTarget
}

/**
 * The selected copy's host, else the owner's when the unqualified owner resolves. An ambiguous twin
 * with no selection stays unplaced, so its git calls refuse instead of guessing a copy.
 */
function placedHostId(state: AppState, worktreeId: string): ExecutionHostId | null {
  const selected = getActiveWorkspaceExecutionHostId(state, worktreeId)
  if (selected) {
    return parseRoutableExecutionHostId(selected)?.id ?? null
  }
  if (!runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId })) {
    return null
  }
  return (
    parseRoutableExecutionHostId(getKnownExecutionHostIdForWorktree(state, worktreeId))?.id ?? null
  )
}

/**
 * Resolves `worktreeId` on `hostId`, or on the selected copy when no host is named. Null when the
 * owner's transport is unknown, so callers skip the call instead of reading the path locally.
 */
export function resolveWorktreeGitCopy(
  state: AppState,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): WorktreeGitCopy | null {
  const copyHostId = hostId ?? placedHostId(state, worktreeId)
  const transport = runtimeTargetForWorkspaceOwner(state, {
    workspaceId: worktreeId,
    ...(copyHostId ? { hostId: copyHostId } : {})
  })
  if (!transport) {
    return null
  }
  // Why the copy lookup: the bare-id one answers undefined for a twin, which a caller would
  // otherwise turn into a local `git status` of the SSH copy's path.
  // A resolved null (local) is an answer; only "unknown" falls through to the copy lookup.
  const bareConnectionId = getConnectionIdFromState(state, worktreeId)
  const connectionId =
    bareConnectionId === undefined && copyHostId
      ? getConnectionIdForWorktreeCopy(state, worktreeId, copyHostId)
      : bareConnectionId
  return {
    worktreeId,
    hostId: copyHostId,
    connectionId: connectionId ?? undefined,
    transport
  }
}

/** {@link resolveWorktreeGitCopy} against the live store. */
export function resolveWorktreeGitCopyNow(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): WorktreeGitCopy | null {
  return resolveWorktreeGitCopy(useAppStore.getState(), worktreeId, hostId)
}

/** The selected copy's host, for a callback that must keep answering for it after a switch. */
export function useWorktreeGitCopyHostId(worktreeId: string | null): ExecutionHostId | null {
  return useAppStore((state) => (worktreeId ? placedHostId(state, worktreeId) : null))
}

/**
 * The publish target of one copy. Ids repeat across hosts, so an id-keyed lookup could hand a Create
 * PR or refresh the other copy's remote and branch; with no host, only a lone copy answers.
 */
export function worktreeCopyPushTarget(
  state: AppState,
  worktreeId: string,
  hostId: ExecutionHostId | null
): GitPushTarget | undefined {
  const placed = hostId
    ? selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: worktreeId, hostId }))
    : undefined
  if (placed) {
    return placed.pushTarget
  }
  // Why the lone-copy fallback: the host index files an unstamped row only under `local`. A row
  // stamped for another host is never this copy, so a named host accepts only an unstamped one.
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (row) => row.id === worktreeId
  )
  const lone = new Set(rows.map(worktreeCopyOwnerKey)).size === 1 ? rows[0] : undefined
  return lone && (!hostId || lone.hostId === undefined) ? lone.pushTarget : undefined
}
