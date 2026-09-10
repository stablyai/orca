import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { findTerminalTabWorktreeId } from './native-chat-file-link'

export type NativeChatRuntimeOwnerState = Pick<AppState, 'tabsByWorktree'> &
  WorktreeRuntimeOwnerState

/**
 * The runtime owner id for a Native Chat pane, as a primitive — non-null only for
 * `runtime:` hosts (Model B), null for local and `ssh:` (Model A stays local).
 *
 * KTD-1: intentionally decoupled from `resolveNativeChatFileLinkContext`, which
 * returns null whenever the worktree *path* can't resolve (store hydration, folder
 * scopes, a remote worktree whose path hasn't landed). In that window the owner is
 * still knowable and the transport must route to the runtime — reusing the
 * path-coupled context would fall back to local session data, the exact bug this
 * kills. Resolve the owner from the tab→worktree mapping alone; do not merge the
 * two selections. The shared helper (`findTerminalTabWorktreeId`) is the right
 * level of reuse.
 */
export function selectNativeChatRuntimeEnvironmentId(
  state: NativeChatRuntimeOwnerState,
  terminalTabId: string
): string | null {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  return worktreeId ? getRuntimeEnvironmentIdForWorktree(state, worktreeId) : null
}

/** The local project runtime is separate from Model B's runtime owner. WSL is
 * local to the device but not local to host-scoped OMP RPC. */
export function selectNativeChatProjectRuntime(
  state: AppState,
  terminalTabId: string
): ProjectExecutionRuntimeResolution | undefined {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  return worktreeId ? getLocalProjectExecutionRuntimeContext(state, worktreeId) : undefined
}

/** Owner resolution reads the folder and project-group catalogs too, which the
 *  worktree-only runtime-owner state does not require. */
export type NativeChatPaneConnectionState = Pick<AppState, 'tabsByWorktree'> &
  WorktreeRuntimeOwnerState

/**
 * The SSH target owning a Native Chat pane's worktree: null when this client
 * owns it, a target id for a remote host, `undefined` when ownership has not
 * resolved (the worktree or its repo has not hydrated, the tab maps to no
 * worktree, or a runtime owns the pane) and the answer is therefore unknown.
 *
 * `undefined` is deliberately distinct from `null`. RPC session ownership spawns
 * `omp` on this client, so "we could not ask who owns this worktree" must not
 * read as "this client owns it" — see docs/reference/ssh-execution-boundary.md
 * and `resolveOmpRpcPaneExecutionHost`, which consumes this alongside the
 * runtime owner id above.
 *
 * Ownership comes from `getResolvedExecutionHostIdForWorktree`, the repository's
 * one authoritative host ladder (worktree `hostId` → repo `executionHostId` →
 * repo `connectionId`). The repo-level `getConnectionIdFromState` resolver reads
 * only the ladder's bottom rung, so an SSH worktree sharing a catalog row with a
 * local checkout would classify as local.
 */
export function selectNativeChatPaneConnectionId(
  state: NativeChatPaneConnectionState,
  terminalTabId: string
): string | null | undefined {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  return worktreeId === null ? undefined : selectNativeChatWorktreeConnectionId(state, worktreeId)
}

/** The same ownership verdict for a worktree the caller already has in hand.
 *  Shared so every native-chat gate on one pane answers from one ladder
 *  (XLR-009): the transcript-readability gate used to read the repo-only
 *  `getConnectionIdFromState`, so an `ssh:` worktree under a local repo row was
 *  admitted as locally readable by the very pane RPC ownership refused. */
export function selectNativeChatWorktreeConnectionId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): string | null | undefined {
  const host = parseExecutionHostId(getResolvedExecutionHostIdForWorktree(state, worktreeId))
  if (host?.kind === 'local') {
    return null
  }
  // A runtime host is resolved, but it is not an SSH target and not this client:
  // leave it unknown rather than let it fall through to the local verdict.
  return host?.kind === 'ssh' ? host.targetId : undefined
}
