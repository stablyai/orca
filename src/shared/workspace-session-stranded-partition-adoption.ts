import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  WORKSPACE_SESSION_FIELD_OWNERSHIP,
  type WorkspaceSessionFieldOwnership
} from './workspace-session-host-field-ownership'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'
import { isWorktreeHostIdentity as isHostQualifiedSessionKey } from './worktree/host-qualified-identity'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  worktreeIdForPaneKey
} from './workspace-session-host-records'

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
 * Adoption is told which session keys the read found **contested**. Every rule below rests on the
 * premise that `local` and `ssh:<targetId>` are one workspace written twice — and a bare
 * `repoId::path` id claimed by more than one host is exactly where that premise is false. The
 * contention split cannot see it, because ssh slices are deliberately kept out of the claimant set,
 * so the verdict is passed in instead: a contested key may still be gap-filled, never replaced.
 * Without that, an SSH workspace's rows overwrote a different workspace's rows under the same id,
 * and routing then wrote them into that workspace's own partition.
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

/**
 * Whether the host has nothing to say about a key. `[]`, `{}` and null/undefined all mean the host
 * holds no rows, which is never evidence that the base's rows are wrong — the same reading the base
 * side already gives an empty tab row, and `docs/reference/ssh-execution-boundary.md` generalises.
 * Without this an empty host `openFilesByWorktree` row replaced a populated base one and destroyed
 * an unsaved `dirtyDraftContent`, which no other channel can recover. The symmetric cost is that a
 * row the host really did empty stays visible for one more launch, and a resurrected editor tab is
 * non-destructive where a destroyed draft is not.
 */
function hostHasNothingFor(entry: unknown): boolean {
  if (entry === null || entry === undefined) {
    return true
  }
  if (Array.isArray(entry)) {
    return entry.length === 0
  }
  return typeof entry === 'object' && Object.keys(entry as KeyedRecord).length === 0
}

function adoptRecord(
  next: WorkspaceSessionState,
  host: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  shouldAdopt: (key: string, entry: unknown) => boolean,
  /** Whether this key's host row may replace the base's, rather than only fill a gap. An adoptable
   *  workspace is host-owned, so its populated rows supersede the base's leftovers — but only where
   *  the id names one workspace and the host actually holds something. */
  mayReplace: boolean | ((key: string) => boolean) = false
): void {
  const hostRecord = asRecord(host[field])
  if (!hostRecord) {
    return
  }
  const merged = { ...asRecord(next[field]) }
  for (const [key, entry] of Object.entries(hostRecord)) {
    const replaces =
      (typeof mayReplace === 'function' ? mayReplace(key) : mayReplace) && !hostHasNothingFor(entry)
    if (shouldAdopt(key, entry) && (replaces || !Object.hasOwn(merged, key))) {
      merged[key] = entry
    }
  }
  ;(next as KeyedRecord)[field] = merged
}

export type StrandedPartitionAdoptionOptions = {
  /** Session keys the contention split found claimed by more than one partition. */
  contestedSessionKeys?: ReadonlySet<string>
}

export function adoptStrandedHostPartitionSession(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState | null | undefined,
  options: StrandedPartitionAdoptionOptions = {}
): WorkspaceSessionState {
  if (!host) {
    return base
  }
  const adoptable = adoptableWorkspaceIds(base, host)
  if (adoptable.size === 0) {
    return base
  }
  const contested = new Set<string>()
  for (const key of options.contestedSessionKeys ?? []) {
    contested.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  }
  const adopts = (key: string): boolean =>
    adoptable.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  const isContested = (key: string): boolean =>
    contested.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))

  const next: WorkspaceSessionState = { ...base, tabsByWorktree: { ...base.tabsByWorktree } }
  for (const [key, tabs] of Object.entries(host.tabsByWorktree ?? {})) {
    if (!adopts(key) || !Array.isArray(tabs)) {
      continue
    }
    // A contested id is not this workspace written twice, so the base's own row stays.
    if (!isContested(key) || !Object.hasOwn(next.tabsByWorktree, key)) {
      next.tabsByWorktree[key] = tabs
    }
  }
  // Why the split's own indexes: they are what decided which partition each tab-, pane- and
  // file-keyed row was written to, so reading them back through anything else lets the two walks
  // disagree. `buildWorktreeIdByTabId` also covers unified-only tabs, whose layout and PTY records
  // the split routes here and a `tabsByWorktree`-only walk never adopted back. Computed up front so
  // the keyed fields do not depend on the ownership table's declaration order.
  const worktreeIdByTabId = buildWorktreeIdByTabId(host)
  const worktreeIdByFileId = buildWorktreeIdByFileId(host)
  const adoptsResolved = (worktreeId: string | undefined): boolean =>
    worktreeId !== undefined && adopts(worktreeId)

  for (const field of SESSION_FIELDS) {
    const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    switch (ownership) {
      case 'global':
      case 'hostPrivate':
        // 'local' owns the globals; hostPrivate is main's own per-partition fence.
        break
      case 'worktreeKeyed':
        if (field !== 'tabsByWorktree') {
          // Why a bare recency key only fills a gap: `lastVisitedAtByWorktreeId` is the one field in
          // this kind whose key may carry a host (`<hostId>|<worktreeId>`), and the split has its
          // own branch for that. A qualified key names its owner and cannot collide; a bare one is
          // indistinguishable from another host's entry for the same id, and replacing moved a
          // local workspace's Cmd+J position permanently.
          adoptRecord(
            next,
            host,
            field,
            (key) => adopts(key),
            (key) =>
              !isContested(key) &&
              (field !== 'lastVisitedAtByWorktreeId' || isHostQualifiedSessionKey(key))
          )
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
        adoptRecord(next, host, field, (key) => adoptsResolved(worktreeIdByTabId.get(key)))
        break
      case 'paneKeyed':
        adoptRecord(next, host, field, (key) =>
          adoptsResolved(worktreeIdForPaneKey(worktreeIdByTabId, key))
        )
        break
      case 'sleepingAgentKeyed':
      case 'surfaceTombstoneKeyed':
        // Keyed opaquely, but each record names its own workspace — the only routing left once the
        // tab or pane it describes is gone, and the same one `splitWorkspaceSessionByHost` uses.
        adoptRecord(next, host, field, (_key, entry) => {
          const workspaceId = recordWorkspaceId(entry)
          return workspaceId !== null && adopts(workspaceId)
        })
        break
      case 'browserWorkspaceKeyed':
        adoptRecord(next, host, field, (_key, entry) => {
          const workspaceId = browserPagesWorkspaceId(entry)
          return workspaceId !== null && adopts(workspaceId)
        })
        break
      case 'fileKeyed':
        // Routed by the open file's workspace, through the same index the split routed it by.
        adoptRecord(next, host, field, (key) => adoptsResolved(worktreeIdByFileId.get(key)))
        break
    }
  }
  return next
}
