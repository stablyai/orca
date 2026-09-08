import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  WORKSPACE_SESSION_FIELD_OWNERSHIP,
  type WorkspaceSessionFieldOwnership
} from './workspace-session-host-field-ownership'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

/**
 * Fold rows a host partition holds alone back into the session the readers assemble.
 *
 * Shipping builds split one SSH workspace's session across two partitions: the renderer wrote
 * `local`, the main-process runtime wrote `ssh:<targetId>` (#12723). `workspaceSessionPartitionHostId`
 * now names a single owner, but both stores still hold real data, so every reader has to reunite
 * them once before the write path returns the result to that owner.
 *
 * **A workspace is adopted whenever the host partition names it at all — not only when it has
 * terminal tabs.** The write path routes EVERY worktree-scoped field to the owning partition, so a
 * workspace with open editor files, browser tabs or tab groups and no terminals lives there just as
 * completely as one with terminals. Gating on tabs would strand exactly those, and unlike terminal
 * state they cannot be recovered from the SSH host snapshot, which carries terminal fields only —
 * an unsaved `dirtyDraftContent` would be destroyed outright.
 *
 * That is why the walk below switches exhaustively over `WORKSPACE_SESSION_FIELD_OWNERSHIP` instead
 * of listing the fields it knows about: a hand-maintained list is what let editor and browser state
 * fall out, and a new ownership kind must not be able to fall out the same way.
 *
 * The one thing the base keeps unconditionally is a workspace it holds **terminal tabs** for. That
 * is the live copy the user is looking at, and merging a stale partition into it would re-add tabs
 * they had closed on every launch. Leaving it alone keeps this a one-shot repair, at the cost of
 * not recovering rows stranded beside a populated workspace — which are stranded on main today too,
 * so it is never a new loss. An EMPTY tab row is not such a copy: an empty list is not evidence
 * that anything was closed (`mergeDirectSshRemoteWorkspaceSession` argues this at length, and
 * docs/reference/ssh-execution-boundary.md makes it general — "we could not see it" is
 * `unverifiable`, never proof of absence). Treating it as the truth is what published an empty tab
 * list and let `replace-session` delete the host's copy (#12721).
 */

type KeyedRecord = Record<string, unknown>

const SESSION_FIELDS = Object.keys(
  WORKSPACE_SESSION_FIELD_OWNERSHIP
) as (keyof WorkspaceSessionState)[]

function asRecord(value: unknown): KeyedRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as KeyedRecord) : null
}

function recordWorkspaceId(entry: unknown): string | null {
  const worktreeId = asRecord(entry)?.worktreeId
  return typeof worktreeId === 'string' ? worktreeId : null
}

/** A browser-workspace row is keyed by browser workspace id; its pages name the workspace. */
function browserPagesWorkspaceId(entry: unknown): string | null {
  const first = Array.isArray(entry) ? (entry[0] as unknown) : null
  return recordWorkspaceId(first)
}

/** Workspaces the base holds terminal tabs for: its live copies, which adoption never touches. */
function workspacesTheBaseOwns(base: WorkspaceSessionState): Set<string> {
  const owned = new Set<string>()
  for (const [key, tabs] of Object.entries(base.tabsByWorktree ?? {})) {
    if (Array.isArray(tabs) && tabs.length > 0) {
      owned.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  return owned
}

/** Every workspace the host partition names in any scoped field, minus the base's live copies. */
function adoptableWorkspaceIds(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState
): Set<string> {
  const owned = workspacesTheBaseOwns(base)
  const adoptable = new Set<string>()
  const consider = (value: string | null | undefined): void => {
    if (!value) {
      return
    }
    const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(value)
    if (!owned.has(workspaceId)) {
      adoptable.add(workspaceId)
    }
  }
  for (const field of SESSION_FIELDS) {
    const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    const value = host[field]
    switch (ownership) {
      case 'global':
      case 'hostPrivate':
      case 'tabKeyed':
      case 'paneKeyed':
      case 'fileKeyed':
        // Keyed by something the workspaces below already account for.
        break
      case 'worktreeKeyed':
        for (const key of Object.keys(asRecord(value) ?? {})) {
          consider(key)
        }
        break
      case 'worktreeArray':
        for (const id of Array.isArray(value) ? (value as string[]) : []) {
          consider(id)
        }
        break
      case 'sleepingAgentKeyed':
      case 'surfaceTombstoneKeyed':
        for (const entry of Object.values(asRecord(value) ?? {})) {
          consider(recordWorkspaceId(entry))
        }
        break
      case 'browserWorkspaceKeyed':
        for (const entry of Object.values(asRecord(value) ?? {})) {
          consider(browserPagesWorkspaceId(entry))
        }
        break
    }
  }
  return adoptable
}

function adoptRecord(
  next: WorkspaceSessionState,
  host: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  shouldAdopt: (key: string, entry: unknown) => boolean,
  /** Adoptable workspaces are host-owned, so their rows replace the base's leftovers; everything
   *  else only fills a gap, so nothing the base already answered is overwritten. */
  replace: boolean
): void {
  const hostRecord = asRecord(host[field])
  if (!hostRecord) {
    return
  }
  const merged = { ...asRecord(next[field]) }
  for (const [key, entry] of Object.entries(hostRecord)) {
    if (shouldAdopt(key, entry) && (replace || !Object.hasOwn(merged, key))) {
      merged[key] = entry
    }
  }
  ;(next as KeyedRecord)[field] = merged
}

export function adoptStrandedHostPartitionSession(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  if (!host) {
    return base
  }
  const adoptable = adoptableWorkspaceIds(base, host)
  if (adoptable.size === 0) {
    return base
  }
  const adopts = (key: string): boolean =>
    adoptable.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))

  const next: WorkspaceSessionState = { ...base, tabsByWorktree: { ...base.tabsByWorktree } }
  const adoptedTabIds = new Set<string>()
  for (const [key, tabs] of Object.entries(host.tabsByWorktree ?? {})) {
    if (!adopts(key) || !Array.isArray(tabs)) {
      continue
    }
    next.tabsByWorktree[key] = tabs
    for (const tab of tabs) {
      adoptedTabIds.add(tab.id)
    }
  }
  // Computed up front rather than as the walk passes `openFilesByWorktree`, so the file-keyed
  // fields do not depend on the ownership table's declaration order.
  const adoptedFileIds = new Set<string>()
  for (const [key, files] of Object.entries(asRecord(host.openFilesByWorktree) ?? {})) {
    if (!adopts(key)) {
      continue
    }
    for (const file of Array.isArray(files) ? files : []) {
      const filePath = asRecord(file)?.filePath
      if (typeof filePath === 'string') {
        adoptedFileIds.add(filePath)
      }
    }
  }

  for (const field of SESSION_FIELDS) {
    const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    switch (ownership) {
      case 'global':
      case 'hostPrivate':
        // 'local' owns the globals; hostPrivate is main's own per-partition fence.
        break
      case 'worktreeKeyed':
        if (field !== 'tabsByWorktree') {
          adoptRecord(next, host, field, (key) => adopts(key), true)
        }
        break
      case 'worktreeArray': {
        const hostIds = host[field]
        const adopted = (Array.isArray(hostIds) ? (hostIds as string[]) : []).filter(adopts)
        if (adopted.length > 0) {
          const baseIds = next[field]
          ;(next as KeyedRecord)[field] = [
            ...new Set([...(Array.isArray(baseIds) ? (baseIds as string[]) : []), ...adopted])
          ]
        }
        break
      }
      case 'tabKeyed':
      case 'paneKeyed':
        // Keyed by a tab id, or by a pane key that starts with one. Tab ids are colon-free, so the
        // first segment identifies the owning tab in both shapes.
        adoptRecord(
          next,
          host,
          field,
          (key) => adoptedTabIds.has(key.split(':', 1)[0] ?? ''),
          false
        )
        break
      case 'sleepingAgentKeyed':
      case 'surfaceTombstoneKeyed':
        // Keyed opaquely, but each record names its own workspace — the only routing left once the
        // tab or pane it describes is gone, and the same one `splitWorkspaceSessionByHost` uses.
        adoptRecord(
          next,
          host,
          field,
          (_key, entry) => {
            const workspaceId = recordWorkspaceId(entry)
            return workspaceId !== null && adopts(workspaceId)
          },
          false
        )
        break
      case 'browserWorkspaceKeyed':
        adoptRecord(
          next,
          host,
          field,
          (_key, entry) => {
            const workspaceId = browserPagesWorkspaceId(entry)
            return workspaceId !== null && adopts(workspaceId)
          },
          false
        )
        break
      case 'fileKeyed':
        // Routed by the open file's workspace, so it follows the files adopted just above.
        adoptRecord(next, host, field, (key) => adoptedFileIds.has(key), false)
        break
    }
  }
  return next
}
