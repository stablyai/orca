import type { DesktopRelayOwnership, WorkspaceSessionState } from './workspace-session-state-types'

/** Bump when legacy adoption changes; a partition adopts once per version. */
export const DESKTOP_RELAY_LEGACY_ADOPTION_VERSION = 1

/** The desktop window's relay ids for one host partition. `complete` means the window speaks for
 *  every relay of that host it could save, so an owned key it leaves out has ended. */
export type DesktopRelayHostWrite = {
  relayIdsByTabId: Record<string, string>
  complete: boolean
}

type RelayFields = Pick<WorkspaceSessionState, 'remoteSessionIdsByTabId' | 'desktopRelayOwnership'>

/** Relay ids saved before ownership was recorded that the window may treat as its own. */
export type LegacyRelayAdoption = (session: WorkspaceSessionState) => Record<string, string>

/** Apply the desktop window's relay ids to one partition: it sets and removes only keys it owns (the
 *  stored id is still the one it wrote), claims a key main holds only by sending the same id, and never
 *  revives a key main took over. Returns the changed fields, or null when nothing changes. */
export function applyDesktopRelayWrite(
  session: WorkspaceSessionState,
  write: DesktopRelayHostWrite,
  adoptLegacy: LegacyRelayAdoption
): RelayFields | null {
  const stored = session.remoteSessionIdsByTabId ?? {}
  const before = session.desktopRelayOwnership
  const owners: Record<string, string | null> = { ...before?.relayIdByTabId }
  let adopted = false
  if ((before?.legacyAdoptionVersion ?? 0) < DESKTOP_RELAY_LEGACY_ADOPTION_VERSION) {
    for (const [tabId, relayId] of Object.entries(adoptLegacy(session))) {
      // A key main revoked, or one already recorded, is not legacy.
      if (!Object.hasOwn(owners, tabId) && stored[tabId] === relayId) {
        owners[tabId] = relayId
      }
    }
    adopted = true
  }
  const relays: Record<string, string> = { ...stored }
  const desired = write.relayIdsByTabId
  for (const tabId of new Set([
    ...Object.keys(stored),
    ...Object.keys(desired),
    ...Object.keys(owners)
  ])) {
    const wanted = desired[tabId]
    const current = stored[tabId]
    const owner = owners[tabId]
    const owned = typeof owner === 'string' && owner === current
    if (wanted !== undefined) {
      if (current === undefined) {
        // A key main retired stays retired until the window agrees it is gone.
        if (owner !== null) {
          relays[tabId] = wanted
          owners[tabId] = wanted
        }
      } else if (owned || current === wanted) {
        relays[tabId] = wanted
        owners[tabId] = wanted
      }
      continue
    }
    if (!write.complete) {
      continue
    }
    if (current === undefined) {
      delete owners[tabId]
    } else if (owned) {
      delete relays[tabId]
      delete owners[tabId]
    }
  }
  const relaysChanged = !sameStringRecord(stored, relays)
  const ownersChanged = adopted || !sameStringRecord(before?.relayIdByTabId ?? {}, owners)
  if (!relaysChanged && !ownersChanged) {
    return null
  }
  return {
    remoteSessionIdsByTabId: Object.keys(relays).length > 0 ? relays : undefined,
    desktopRelayOwnership: {
      legacyAdoptionVersion: Math.max(
        before?.legacyAdoptionVersion ?? 0,
        DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
      ),
      relayIdByTabId: owners
    }
  }
}

/** For main writers: the window no longer owns these keys, even if main wrote the same relay id. */
export function withMainRelayKeys<T extends Pick<WorkspaceSessionState, 'desktopRelayOwnership'>>(
  session: T,
  tabIds: Iterable<string>
): T {
  const before: DesktopRelayOwnership | undefined = session.desktopRelayOwnership
  const owners = { ...before?.relayIdByTabId }
  let changed = false
  for (const tabId of tabIds) {
    if (owners[tabId] !== null) {
      owners[tabId] = null
      changed = true
    }
  }
  if (!changed) {
    return session
  }
  return {
    ...session,
    desktopRelayOwnership: {
      legacyAdoptionVersion: before?.legacyAdoptionVersion ?? 0,
      relayIdByTabId: owners
    }
  }
}

function sameStringRecord(
  left: Record<string, string | null>,
  right: Record<string, string | null>
): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) {
    return false
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}
