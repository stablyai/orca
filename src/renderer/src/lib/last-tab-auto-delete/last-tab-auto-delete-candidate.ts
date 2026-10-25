import type { AppState } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { readLastTabAutoDeleteMode } from '../../../../shared/worktree-deletion-preferences'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getAllWorktreesFromState } from '@/store/selectors'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** `close` is a user close; `exit` is a process exit the user did not click. */
export type LastTabAutoDeleteTrigger = 'close' | 'exit'

export type LastTabAutoDeleteCandidate = {
  /** Tab-model key: the worktree id or `folder:<id>`. */
  workspaceKey: string
  trigger: LastTabAutoDeleteTrigger
  wasActive: boolean
  hostId?: ExecutionHostId
  /** Git worktrees only: pins the delete to the incarnation that emptied. */
  instanceId?: string
}

/**
 * Snapshot taken when the close is requested: the selection is cleared before the close lands, and
 * an unresolvable host yields no candidate rather than the first same-id row (STA-4343).
 */
export function captureLastTabAutoDeleteCandidate(
  state: AppState,
  workspaceKey: string,
  opts: { trigger: LastTabAutoDeleteTrigger; hostId?: ExecutionHostId }
): LastTabAutoDeleteCandidate | null {
  if (
    workspaceKey === FLOATING_TERMINAL_WORKTREE_ID ||
    readLastTabAutoDeleteMode(state.settings?.deleteWorkspaceOnLastTabClose) === 'off' ||
    isPairedWebClientWindow()
  ) {
    return null
  }
  const wasActive = state.activeWorktreeId === workspaceKey
  const knownHostId =
    opts.hostId ?? (wasActive ? (state.activeWorkspaceExecutionHostId ?? undefined) : undefined)
  const base = { workspaceKey, trigger: opts.trigger, wasActive }

  const scope = parseWorkspaceKey(workspaceKey)
  if (scope?.type === 'folder') {
    const rows = selectFolderWorkspaces(state).filter(
      (workspace) => workspace.id === scope.folderWorkspaceId
    )
    if (rows.length === 0) {
      return null
    }
    // Why the same host function as the filter: any other resolution could miss the row at run time.
    const rowHosts = new Set(
      rows.map((workspace) => getFolderWorkspaceHostId(workspace, state.projectGroups))
    )
    if (knownHostId) {
      return rowHosts.has(knownHostId) ? { ...base, hostId: knownHostId } : null
    }
    return rowHosts.size === 1 ? { ...base, hostId: Array.from(rowHosts)[0] } : null
  }

  const rows = getAllWorktreesFromState(state).filter((worktree) => worktree.id === workspaceKey)
  // Why the hostless fallback: legacy rows predate `hostId`, so a sole hostless row is still this one.
  const row = knownHostId
    ? (rows.find((worktree) => worktree.hostId === knownHostId) ??
      (rows.length === 1 && !rows[0].hostId ? rows[0] : undefined))
    : rows[0]
  if (!row || (!knownHostId && rows.length > 1)) {
    return null
  }
  return {
    ...base,
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(row.instanceId ? { instanceId: row.instanceId } : {})
  }
}
