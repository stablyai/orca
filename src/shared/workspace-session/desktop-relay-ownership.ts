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

type RelayFields = Pick<WorkspaceSessionState, 'remoteSessionIdsByTabId' | 'desktopRelayOwnership'>

/** Relay ids saved before ownership was recorded that the window may treat as its own. */
export type LegacyRelayAdoption = (session: WorkspaceSessionState) => Record<string, string>

export type DesktopRelayApplyResult = {
  /** The changed fields, or null when nothing changes. */
  patch: RelayFields | null
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
  const before = session.desktopRelayOwnership
  const owners: Record<string, string> = { ...before?.relayIdByTabId }
  const adopting =
    adoptLegacy !== null &&
    (before?.legacyAdoptionVersion ?? 0) < DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
  if (adoptLegacy && adopting) {
    for (const [tabId, relayId] of Object.entries(adoptLegacy(session))) {
      if (!Object.hasOwn(owners, tabId) && stored[tabId] === relayId) {
        owners[tabId] = relayId
      }
    }
  }
  const relays: Record<string, string> = { ...stored }
  const desired = write.relayIdsByTabId
  const removed = write.removedTabIds
  let liveTabs: Set<string> | null = null
  let refused = false
  const touched = removed
    ? [...Object.keys(desired), ...removed]
    : new Set([...Object.keys(stored), ...Object.keys(desired), ...Object.keys(owners)])
  for (const tabId of touched) {
    const wanted = desired[tabId]
    const current = stored[tabId]
    const owned = owners[tabId] !== undefined && owners[tabId] === current
    if (wanted !== undefined) {
      if (current === wanted || owned) {
        relays[tabId] = wanted
        owners[tabId] = wanted
        continue
      }
      liveTabs ??= tabIdsWithRows(session)
      if (current === undefined && liveTabs.has(tabId)) {
        relays[tabId] = wanted
        owners[tabId] = wanted
      } else {
        refused = true
      }
      continue
    }
    if (!removed && !write.complete) {
      continue
    }
    if (owned) {
      delete relays[tabId]
    }
    // A key the window no longer holds, or whose id main changed, is no longer the window's.
    if (owned || owners[tabId] !== current) {
      delete owners[tabId]
    }
  }
  const relaysChanged = !sameRecord(stored, relays)
  const ownersChanged = adopting || !sameRecord(before?.relayIdByTabId ?? {}, owners)
  if (!relaysChanged && !ownersChanged) {
    return { patch: null, refused }
  }
  return {
    refused,
    patch: {
      remoteSessionIdsByTabId: Object.keys(relays).length > 0 ? relays : undefined,
      desktopRelayOwnership: {
        legacyAdoptionVersion: adopting
          ? DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
          : (before?.legacyAdoptionVersion ?? 0),
        relayIdByTabId: owners
      }
    }
  }
}

/** For main writers that change or remove these keys' relay ids: the window no longer owns them. A
 *  main write of the same id keeps the binding, so it keeps the window's ownership. */
export function forgetDesktopRelayKeys<
  T extends Pick<WorkspaceSessionState, 'desktopRelayOwnership'>
>(session: T, tabIds: Iterable<string>): T {
  const before = session.desktopRelayOwnership
  if (!before) {
    return session
  }
  const owners = { ...before.relayIdByTabId }
  let changed = false
  for (const tabId of tabIds) {
    if (Object.hasOwn(owners, tabId)) {
      delete owners[tabId]
      changed = true
    }
  }
  return changed
    ? { ...session, desktopRelayOwnership: { ...before, relayIdByTabId: owners } }
    : session
}

/** Keys whose relay id differs between two maps (changed, added or removed). */
export function changedRelayKeys(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter((key) => before?.[key] !== after?.[key])
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

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) {
    return false
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}
