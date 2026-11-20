import type { WorkspaceSessionState } from './workspace-session-state-types'

/** Bump when legacy adoption changes; a partition adopts once per version. */
export const DESKTOP_RELAY_LEGACY_ADOPTION_VERSION = 1

/** The desktop window's relay ids for one host partition. A baseline carries every id the window holds
 *  there; `complete` then means an owned id it leaves out has ended. A delta (after a baseline main
 *  accepted) sets and removes only the ids it names. */
export type DesktopRelayHostWrite = {
  relayIdsByTabId: Record<string, string>
  complete: boolean
  /** Present on a delta: the ids the window no longer holds. */
  removedTabIds?: string[]
}

type RelayFields = Pick<
  WorkspaceSessionState,
  'remoteSessionIdsByTabId' | 'desktopRelayOwnerByTabId' | 'desktopRelayAdoptionVersion'
>

/** Relay ids saved before ownership was recorded that the window may treat as its own. */
export type LegacyRelayAdoption = (session: WorkspaceSessionState) => Record<string, string>

export type DesktopRelayApplyResult = {
  /** The changed fields, or null when nothing changes. */
  patch: RelayFields | null
  /** Tabs whose relay id or ownership the patch changes. */
  changedTabIds: string[]
  /** An id the window wanted was refused (main holds another id there); resend a baseline later. */
  refused: boolean
}

/** Apply the desktop window's relay ids to one partition. It sets and removes only keys it owns (the
 *  stored id is still the one it wrote), claims a key main holds only by sending that same id, and
 *  claims an empty key only for a tab row the partition still has. */
export function applyDesktopRelayWrite(
  session: WorkspaceSessionState,
  write: DesktopRelayHostWrite,
  // null: don't adopt now (unload staging sees rows before the snapshot's placement); a later write will.
  adoptLegacy: LegacyRelayAdoption | null
): DesktopRelayApplyResult {
  const stored = session.remoteSessionIdsByTabId ?? {}
  const before = session.desktopRelayOwnerByTabId ?? {}
  // Changes keyed by tab (undefined deletes); maps are copied only when something changes.
  const relayChanges = new Map<string, string | undefined>()
  const ownerChanges = new Map<string, string | undefined>()
  const ownerOf = (tabId: string) =>
    ownerChanges.has(tabId) ? ownerChanges.get(tabId) : before[tabId]
  const adopting =
    adoptLegacy !== null &&
    (session.desktopRelayAdoptionVersion ?? 0) < DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
  if (adoptLegacy && adopting) {
    for (const [tabId, relayId] of Object.entries(adoptLegacy(session))) {
      if (!Object.hasOwn(before, tabId) && stored[tabId] === relayId) {
        ownerChanges.set(tabId, relayId)
      }
    }
  }
  const desired = write.relayIdsByTabId
  const removed = write.removedTabIds
  let liveTabs: Set<string> | null = null
  let refused = false
  // Only a complete baseline's omissions remove anything, so only it visits every stored key.
  const touched = removed
    ? new Set([...Object.keys(desired), ...removed])
    : write.complete
      ? new Set([...Object.keys(stored), ...Object.keys(desired), ...Object.keys(before)])
      : Object.keys(desired)
  for (const tabId of touched) {
    const wanted = desired[tabId]
    const current = stored[tabId]
    const owner = ownerOf(tabId)
    const owned = owner !== undefined && owner === current
    if (wanted !== undefined) {
      if (current === wanted || owned) {
        relayChanges.set(tabId, wanted)
        ownerChanges.set(tabId, wanted)
        continue
      }
      // Main holds another id there: refuse without indexing rows, which only an empty key needs.
      if (current === undefined && (liveTabs ??= tabIdsWithRows(session)).has(tabId)) {
        relayChanges.set(tabId, wanted)
        ownerChanges.set(tabId, wanted)
      } else {
        refused = true
      }
      continue
    }
    if (!removed && !write.complete) {
      continue
    }
    if (owned) {
      relayChanges.set(tabId, undefined)
    }
    // A key the window no longer holds, or whose id main changed, is no longer the window's.
    if (owned || owner !== current) {
      ownerChanges.set(tabId, undefined)
    }
  }
  const relaysChanged = [...relayChanges].filter(([tabId, relayId]) => stored[tabId] !== relayId)
  const ownersChanged = [...ownerChanges].filter(([tabId, relayId]) => before[tabId] !== relayId)
  if (relaysChanged.length === 0 && ownersChanged.length === 0 && !adopting) {
    return { patch: null, refused, changedTabIds: [] }
  }
  const patch: RelayFields = {}
  if (relaysChanged.length > 0) {
    patch.remoteSessionIdsByTabId = withChanges(stored, relaysChanged)
  }
  if (ownersChanged.length > 0) {
    patch.desktopRelayOwnerByTabId = withChanges(before, ownersChanged)
  }
  if (adopting) {
    patch.desktopRelayAdoptionVersion = DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
  }
  const changedTabIds = [...new Set([...relaysChanged, ...ownersChanged].map(([tabId]) => tabId))]
  return { refused, patch, changedTabIds }
}

function withChanges(
  record: Record<string, string>,
  changes: readonly (readonly [string, string | undefined])[]
): Record<string, string> | undefined {
  const next = { ...record }
  for (const [tabId, value] of changes) {
    if (value === undefined) {
      delete next[tabId]
    } else {
      next[tabId] = value
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** For main writers that change or remove these keys' relay ids: the window no longer owns them. A
 *  main write of the same id keeps the binding, so it keeps the window's ownership. */
export function forgetDesktopRelayKeys<
  T extends Pick<WorkspaceSessionState, 'desktopRelayOwnerByTabId'>
>(session: T, tabIds: readonly string[]): T {
  const before = session.desktopRelayOwnerByTabId
  const owned = before ? tabIds.filter((tabId) => Object.hasOwn(before, tabId)) : []
  if (!before || owned.length === 0) {
    return session
  }
  const owners = { ...before }
  for (const tabId of owned) {
    delete owners[tabId]
  }
  return {
    ...session,
    desktopRelayOwnerByTabId: Object.keys(owners).length > 0 ? owners : undefined
  }
}

/** Of the keys a main writer touched, those whose relay id it changed or removed. */
export function changedRelayKeys(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  tabIds: Iterable<string>
): string[] {
  return [...new Set(tabIds)].filter((tabId) => before?.[tabId] !== after?.[tabId])
}

function tabIdsWithRows(session: WorkspaceSessionState): Set<string> {
  const tabIds = new Set<string>()
  for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}
