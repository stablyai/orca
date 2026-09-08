import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { TerminalTab } from './terminal-tab-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-host-field-ownership'

/**
 * Fold rows a host partition holds alone back into the session the readers assemble.
 *
 * Shipping builds split one SSH workspace's session across two partitions: the renderer wrote
 * `local`, the main-process runtime wrote `ssh:<targetId>` (#12723). `workspaceSessionPartitionHostId`
 * now names a single owner, but both stores still hold real data, so every reader has to reunite
 * them once before the write path returns the result to that owner.
 *
 * Strictly gap-filling. A workspace the base holds no tabs for takes the host partition's rows; a
 * workspace the base does hold tabs for keeps them untouched, and the host partition adds nothing.
 *
 * Why an EMPTY tab row counts as a gap and not as an answer: an empty list is not evidence that
 * anything was closed. `mergeDirectSshRemoteWorkspaceSession` already argues this at length, and
 * docs/reference/ssh-execution-boundary.md makes it general — "we could not see it" is
 * `unverifiable`, never proof of absence. Treating that empty row as the truth is exactly what
 * published an empty tab list and let `replace-session` delete the host's copy (#12721).
 *
 * Why nothing is merged INTO a populated workspace: the two lists would have to be unioned by tab
 * id, and a stale row in the unread partition would then re-add tabs the user had closed, on every
 * launch. Leaving a populated workspace alone keeps this a one-shot repair — afterwards the
 * workspace lives in one partition — at the cost of not recovering tabs stranded beside a
 * populated row. Those are stranded on main today too, so that is never a new loss.
 */

type KeyedRecord = Record<string, unknown>

const WORKSPACE_KEYED_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed')

/** Keyed by a tab id, or by a pane key that starts with one, so an adopted workspace's rows can be
 *  recognised by the tabs it brought. */
const TAB_SCOPED_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => {
  const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
  return ownership === 'tabKeyed' || ownership === 'paneKeyed'
})

/** Keyed opaquely, but each record names the workspace it belongs to — the only routing left once
 *  the tab or pane it describes is gone, and the same one `splitWorkspaceSessionByHost` uses. */
const SELF_DESCRIBING_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => {
  const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
  return ownership === 'sleepingAgentKeyed' || ownership === 'surfaceTombstoneKeyed'
})

const WORKSPACE_ARRAY_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeArray')

function asRecord(value: unknown): KeyedRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as KeyedRecord) : null
}

/** Workspaces the host partition is the only side holding tabs for. */
function strandedWorkspaceKeys(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState
): Set<string> {
  const stranded = new Set<string>()
  for (const [key, tabs] of Object.entries(host.tabsByWorktree ?? {})) {
    if (Array.isArray(tabs) && tabs.length > 0 && (base.tabsByWorktree?.[key]?.length ?? 0) === 0) {
      stranded.add(key)
    }
  }
  return stranded
}

export function adoptStrandedHostPartitionSession(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  if (!host) {
    return base
  }
  const stranded = strandedWorkspaceKeys(base, host)
  if (stranded.size === 0) {
    return base
  }
  const tabsByWorktree: Record<string, TerminalTab[]> = { ...base.tabsByWorktree }
  for (const key of stranded) {
    tabsByWorktree[key] = host.tabsByWorktree[key] ?? []
  }
  const next: WorkspaceSessionState = { ...base, tabsByWorktree }
  for (const field of WORKSPACE_KEYED_FIELDS) {
    if (field === 'tabsByWorktree') {
      continue
    }
    const hostRecord = asRecord(host[field])
    if (!hostRecord) {
      continue
    }
    // A stranded workspace's other rows describe the tabs just adopted, so they replace the base's
    // leftovers rather than filling around them.
    const merged = { ...asRecord(next[field]) }
    for (const key of stranded) {
      if (Object.hasOwn(hostRecord, key)) {
        merged[key] = hostRecord[key]
      }
    }
    ;(next as KeyedRecord)[field] = merged
  }
  const adoptedTabIds = new Set(
    [...stranded].flatMap((key) => (host.tabsByWorktree[key] ?? []).map((tab) => tab.id))
  )
  for (const field of TAB_SCOPED_FIELDS) {
    const hostRecord = asRecord(host[field])
    if (!hostRecord) {
      continue
    }
    const merged = { ...asRecord(next[field]) }
    for (const [key, entry] of Object.entries(hostRecord)) {
      // Scoped to the adopted tabs so a tab the base already answered for keeps its own rows.
      if (!Object.hasOwn(merged, key) && adoptedTabIds.has(key.split(':', 1)[0] ?? '')) {
        merged[key] = entry
      }
    }
    ;(next as KeyedRecord)[field] = merged
  }
  for (const field of SELF_DESCRIBING_FIELDS) {
    const hostRecord = asRecord(host[field])
    if (!hostRecord) {
      continue
    }
    const merged = { ...asRecord(next[field]) }
    for (const [key, entry] of Object.entries(hostRecord)) {
      // Why these travel at all: a hibernated agent or a surface tombstone for a stranded workspace
      // is only in the host partition, and the renderer's next full write replaces that partition —
      // so a record the reunited session never carried would be dropped by the repair itself.
      const worktreeId = asRecord(entry)?.worktreeId
      if (
        !Object.hasOwn(merged, key) &&
        typeof worktreeId === 'string' &&
        stranded.has(worktreeId)
      ) {
        merged[key] = entry
      }
    }
    ;(next as KeyedRecord)[field] = merged
  }
  for (const field of WORKSPACE_ARRAY_FIELDS) {
    const hostIds = host[field]
    if (!Array.isArray(hostIds)) {
      continue
    }
    const adopted = (hostIds as string[]).filter((id) => stranded.has(id))
    if (adopted.length === 0) {
      continue
    }
    const baseIds = next[field]
    ;(next as KeyedRecord)[field] = [
      ...new Set([...(Array.isArray(baseIds) ? (baseIds as string[]) : []), ...adopted])
    ]
  }
  return next
}
