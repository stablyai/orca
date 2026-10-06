import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  WORKSPACE_SESSION_FIELD_OWNERSHIP,
  type WorkspaceSessionFieldOwnership
} from './workspace-session-host-field-ownership'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'
import { buildWorktreeIdByTabId, worktreeIdForPaneKey } from './workspace-session-host-records'

type KeyedRecord = Record<string, unknown>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys over the ownership table yields exactly the session field names it is keyed by.
const SESSION_FIELDS = Object.keys(
  WORKSPACE_SESSION_FIELD_OWNERSHIP
) as (keyof WorkspaceSessionState)[]

function asRecord(value: unknown): KeyedRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked object shape
      (value as KeyedRecord)
    : null
}

/**
 * Return rows from a host partition that the upcoming write will NOT return to it: rows for
 * workspaces this partition read but did NOT adopt (because the base owned them, the catalog
 * attributed them to another host, or GAP-03 declined them).
 *
 * Why: writing a session slice back to a host partition replaces that partition wholesale. If this
 * client read rows from an SSH host that it did not adopt into its active session, the next write
 * to that SSH partition would erase those un-adopted rows from disk unless they are parked here
 * first, which is the protection a contested runtime co-claimant already gets. Declining to show a
 * row must never mean deleting it: docs/reference/ssh-execution-boundary.md makes leak, never kill,
 * the safe direction, and a row no partition holds at all is unrecoverable.
 *
 * Why the tab/pane sweep and not just `tabsByWorktree`: a declined worktree's `terminalLayoutsByTabId`
 * and `remoteSessionIdsByTabId` rows are keyed by tab id, not worktree id, so the worktree-keyed
 * walk above never sees them. Without this, a write landing on the same SSH partition before a live
 * answer keeps the declined tab (via the worktree-keyed park) but drops its layout and relay-session
 * rows, leaving the restored tab with no pane to reattach to.
 */
export function partitionRowsTheWriteWontReturn(
  host: WorkspaceSessionState,
  adoptedWorkspaceIds: ReadonlySet<string>
): WorkspaceSessionState | null {
  let parked: KeyedRecord | null = null
  const worktreeIdByTabIdOnHost = buildWorktreeIdByTabId(host)
  const isDeclinedWorktree = (worktreeId: string | undefined): boolean => {
    if (worktreeId === undefined) {
      return false
    }
    const normId = normalizeWorkspaceSessionKeyToWorkspaceId(worktreeId)
    return !adoptedWorkspaceIds.has(normId)
  }
  for (const field of SESSION_FIELDS) {
    const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    if (ownership !== 'worktreeKeyed' && ownership !== 'tabKeyed' && ownership !== 'paneKeyed') {
      continue
    }
    const record = asRecord(host[field])
    if (!record) {
      continue
    }
    let kept: KeyedRecord | null = null
    for (const [key, entry] of Object.entries(record)) {
      const rawWorktreeId =
        ownership === 'worktreeKeyed'
          ? key
          : ownership === 'tabKeyed'
            ? worktreeIdByTabIdOnHost.get(key)
            : worktreeIdForPaneKey(worktreeIdByTabIdOnHost, key)
      const rowWorktreeId =
        rawWorktreeId !== undefined
          ? normalizeWorkspaceSessionKeyToWorkspaceId(rawWorktreeId)
          : undefined
      if (!isDeclinedWorktree(rowWorktreeId)) {
        continue
      }
      kept ??= {}
      kept[key] = entry
    }
    if (kept) {
      parked ??= {}
      parked[field] = kept
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key written here is a session field name taken from the ownership table, and every value is that field's own record copied by reference.
  return parked as WorkspaceSessionState | null
}
