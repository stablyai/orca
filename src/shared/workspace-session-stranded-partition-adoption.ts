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
import { keepUnsavedDrafts } from './workspace-session-draft-retention'

/** Repair sessions split between local and SSH partitions by older writers (#12723). Walk the ownership table exhaustively so terminal-less editor/browser state and future field kinds cannot be stranded; host terminal snapshots cannot recover them.
 * Caller-supplied contested keys permit gap-filling only; foreign keys are never adopted. Report uncontested adopted IDs so writes return rows to their source even before catalog hydration.
 * Keep populated base terminal workspaces to avoid resurrecting closed tabs, except catalog-proven host ownership with populated host tabs supersedes base residue. Empty rows never prove closure (docs/reference/ssh-execution-boundary.md); preserve unsaved drafts across replacement (#12721, #23390, #25616). */

type KeyedRecord = Record<string, unknown>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys over the ownership table yields exactly the session field names it is keyed by.
const SESSION_FIELDS = Object.keys(
  WORKSPACE_SESSION_FIELD_OWNERSHIP
) as (keyof WorkspaceSessionState)[]

function isRecord(value: unknown): value is KeyedRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): KeyedRecord | null {
  return isRecord(value) ? value : null
}

function recordWorkspaceId(entry: unknown): string | null {
  const worktreeId = asRecord(entry)?.worktreeId
  return typeof worktreeId === 'string' ? worktreeId : null
}

function browserPagesWorkspaceId(entry: unknown): string | null {
  const first: unknown = Array.isArray(entry) ? entry[0] : null
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

/** Collect all scoped workspace references for caller catalog checks, including browser pages, sleeping records and shutdown IDs; worktree-keyed maps alone miss these. */
export function workspaceIdsNamedByPartition(host: WorkspaceSessionState): Set<string> {
  return collectWorkspaceIds(host, () => false)
}

/** Every workspace the host partition names in any scoped field, minus the base's live copies. */
function adoptableWorkspaceIds(
  base: WorkspaceSessionState,
  host: WorkspaceSessionState
): Set<string> {
  const owned = workspacesTheBaseOwns(base)
  return collectWorkspaceIds(host, (workspaceId) => owned.has(workspaceId))
}

function collectWorkspaceIds(
  host: WorkspaceSessionState,
  skip: (workspaceId: string) => boolean
): Set<string> {
  const collected = new Set<string>()
  const consider = (value: string | null | undefined): void => {
    if (!value) {
      return
    }
    const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(value)
    if (!skip(workspaceId)) {
      collected.add(workspaceId)
    }
  }
  // Tab/pane/file rows route through worktree-keyed owners already counted here.
  const none = new Map<string, string>()
  for (const field of SESSION_FIELDS) {
    const workspaceOf = entryWorkspaceResolver(field, none, none)
    const value: unknown = host[field]
    const entries = Array.isArray(value)
      ? value.map((id: unknown) => [id, id] as const)
      : Object.entries(asRecord(value) ?? {})
    for (const [key, entry] of entries) {
      consider(typeof key === 'string' ? workspaceOf?.(key, entry) : null)
    }
  }
  return collected
}

/** Empty host rows do not prove base rows wrong. Prefer one-launch stale tabs over destroying base-only drafts; the SSH boundary treats unseen state as unverifiable. */
function hostHasNothingFor(entry: unknown): boolean {
  if (entry === null || entry === undefined) {
    return true
  }
  if (Array.isArray(entry)) {
    return entry.length === 0
  }
  return isRecord(entry) && Object.keys(entry).length === 0
}

function adoptRecord(
  next: WorkspaceSessionState,
  host: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  shouldAdopt: (key: string, entry: unknown) => boolean,
  /** Permit replacement only for owned, uncontested workspaces with populated host rows; otherwise fill gaps. */
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merged record is written back through a dynamic field key, which the session type cannot express.
  ;(next as KeyedRecord)[field] = merged
}

/** Park rows this read will not route back (residue, contested or base-live copies). Replacement partition writes would erase them unless attachHostSessionShadow restores them first. Declining to display a row must never delete its only persisted copy. */
export function partitionRowsTheWriteWontReturn(
  host: WorkspaceSessionState,
  adoptedWorkspaceIds: ReadonlySet<string>
): WorkspaceSessionState | null {
  let parked: KeyedRecord | null = null
  for (const field of SESSION_FIELDS) {
    if (WORKSPACE_SESSION_FIELD_OWNERSHIP[field] !== 'worktreeKeyed') {
      continue
    }
    const record = asRecord(host[field])
    if (!record) {
      continue
    }
    let kept: KeyedRecord | null = null
    for (const [key, entry] of Object.entries(record)) {
      if (adoptedWorkspaceIds.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))) {
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

/** Which workspace an entry of a scoped field belongs to; null for global and host-private fields. */
function entryWorkspaceResolver(
  field: keyof WorkspaceSessionState,
  worktreeIdByTabId: Map<string, string>,
  worktreeIdByFileId: Map<string, string>
): ((key: string, entry: unknown) => string | null | undefined) | null {
  const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
  switch (ownership) {
    case 'global':
    case 'hostPrivate':
      return null
    case 'worktreeKeyed':
    case 'worktreeArray':
      return (key) => key
    case 'tabKeyed':
      return (key) => worktreeIdByTabId.get(key)
    case 'paneKeyed':
      return (key) => worktreeIdForPaneKey(worktreeIdByTabId, key)
    case 'sleepingAgentKeyed':
    case 'surfaceTombstoneKeyed':
      // After tab/pane removal, route records by their own workspace field, matching the split.
      return (_key, entry) => recordWorkspaceId(entry)
    case 'browserWorkspaceKeyed':
      return (_key, entry) => browserPagesWorkspaceId(entry)
    case 'fileKeyed':
      return (key) => worktreeIdByFileId.get(key)
  }
}

export function withoutWorkspaces(
  base: WorkspaceSessionState,
  workspaceIds: ReadonlySet<string>
): WorkspaceSessionState {
  return filterWorkspaceRows(base, (workspaceId) => !workspaceIds.has(workspaceId))
}

export function filterWorkspaceRows(
  base: WorkspaceSessionState,
  keepsWorkspace: (workspaceId: string) => boolean
): WorkspaceSessionState {
  const worktreeIdByTabId = buildWorktreeIdByTabId(base)
  const worktreeIdByFileId = buildWorktreeIdByFileId(base)
  const next: KeyedRecord = { ...base }
  for (const field of SESSION_FIELDS) {
    const workspaceOf = entryWorkspaceResolver(field, worktreeIdByTabId, worktreeIdByFileId)
    const keeps = (key: string, entry: unknown): boolean =>
      keepsWorkspace(normalizeWorkspaceSessionKeyToWorkspaceId(workspaceOf?.(key, entry) ?? ''))
    const value: unknown = base[field]
    if (!workspaceOf || !value) {
      continue
    }
    next[field] = Array.isArray(value)
      ? value.filter((id: string) => keeps(id, id))
      : Object.fromEntries(Object.entries(value).filter(([key, entry]) => keeps(key, entry)))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is the base's own value or a filtered copy of it.
  return next as WorkspaceSessionState
}

/** Owned, uncontested and holding tabs: the host's copy is the live one. No tabs is not a close. */
export function workspacesTheHostSupersedes(
  host: WorkspaceSessionState,
  ownedSessionKeys: ReadonlySet<string> | undefined,
  contested: ReadonlySet<string>
): Set<string> {
  const superseded = new Set<string>()
  for (const [key, tabs] of Object.entries(host.tabsByWorktree ?? {})) {
    const id = normalizeWorkspaceSessionKeyToWorkspaceId(key)
    if (!hostHasNothingFor(tabs) && !contested.has(id) && ownedSessionKeys?.has(id)) {
      superseded.add(id)
    }
  }
  return superseded
}

export type StrandedPartitionAdoptionOptions = {
  /** Session keys the read found claimed by more than one partition. */
  contestedSessionKeys?: ReadonlySet<string>
  /** Catalog-proven foreign rows cannot even gap-fill: that would route stale rows into the real owner’s partition on save. Leave their source rows intact. */
  foreignSessionKeys?: ReadonlySet<string>
  /** Keys the repo catalog attributes to this host. */
  ownedSessionKeys?: ReadonlySet<string>
}

export type StrandedPartitionAdoption = {
  session: WorkspaceSessionState
  /** Bare workspace ids whose rows this partition owns outright, so the write returns them here. */
  adoptedWorkspaceIds: ReadonlySet<string>
}

const NOTHING_ADOPTED: ReadonlySet<string> = new Set<string>()

export function adoptStrandedHostPartitionSession(
  originalBase: WorkspaceSessionState,
  host: WorkspaceSessionState | null | undefined,
  options: StrandedPartitionAdoptionOptions = {}
): StrandedPartitionAdoption {
  if (!host) {
    return { session: originalBase, adoptedWorkspaceIds: NOTHING_ADOPTED }
  }
  const contested = new Set<string>()
  for (const key of options.contestedSessionKeys ?? []) {
    contested.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  }
  const superseded = workspacesTheHostSupersedes(host, options.ownedSessionKeys, contested)
  const base = superseded.size > 0 ? withoutWorkspaces(originalBase, superseded) : originalBase
  const adoptable = adoptableWorkspaceIds(base, host)
  for (const key of options.foreignSessionKeys ?? []) {
    adoptable.delete(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  }
  if (adoptable.size === 0) {
    return { session: base, adoptedWorkspaceIds: NOTHING_ADOPTED }
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
    // Contested populated base rows stay; an empty base row is still a gap, not evidence of closure (#12721).
    if (!isContested(key) || hostHasNothingFor(next.tabsByWorktree[key])) {
      next.tabsByWorktree[key] = tabs
    }
  }
  // Reuse the split’s tab/pane/file indexes, including unified-only tabs, so reads agree with writes. Build first to avoid ownership-table declaration-order dependencies.
  const worktreeIdByTabId = buildWorktreeIdByTabId(host)
  const worktreeIdByFileId = buildWorktreeIdByFileId(host)
  for (const field of SESSION_FIELDS) {
    const ownership: WorkspaceSessionFieldOwnership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    switch (ownership) {
      case 'global':
      case 'hostPrivate':
        // 'local' owns the globals; hostPrivate is main's own per-partition fence.
        break
      case 'worktreeKeyed':
        if (field !== 'tabsByWorktree') {
          // Qualified recency keys name their owner; bare keys may collide across hosts and must only gap-fill to preserve local Cmd+J ordering.
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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktreeArray fields hold worktree ids; the session type does not carry that through a dynamic key.
        const adopted = (Array.isArray(hostIds) ? (hostIds as string[]) : []).filter(adopts)
        if (adopted.length > 0) {
          const baseIds = next[field]
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adopted union is written back through a dynamic field key, which the session type cannot express.
          ;(next as KeyedRecord)[field] = [
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktreeArray fields hold worktree ids; the session type does not carry that through a dynamic key.
            ...new Set([...(Array.isArray(baseIds) ? (baseIds as string[]) : []), ...adopted])
          ]
        }
        break
      }
      case 'tabKeyed':
      case 'paneKeyed':
      case 'sleepingAgentKeyed':
      case 'surfaceTombstoneKeyed':
      case 'browserWorkspaceKeyed':
      case 'fileKeyed': {
        const workspaceOf = entryWorkspaceResolver(field, worktreeIdByTabId, worktreeIdByFileId)
        adoptRecord(next, host, field, (key, entry) => adopts(workspaceOf?.(key, entry) ?? ''))
        break
      }
    }
  }
  keepUnsavedDrafts(next, originalBase)
  // Withhold contested adopted IDs or the write would move a co-claimant’s whole bare workspace here.
  const adoptedWorkspaceIds = new Set(
    [...adoptable].filter((workspaceId) => !contested.has(workspaceId))
  )
  return { session: next, adoptedWorkspaceIds }
}
