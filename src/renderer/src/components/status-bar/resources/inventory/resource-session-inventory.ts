import {
  ptySessionIdentity,
  type PtyListedSession as DaemonSession
} from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'

/** Last-known daemon terminal inventory for the Resource Manager badge. */
export type DaemonSessionInventory = {
  sessions: DaemonSession[]
  count: number
}

export const EMPTY_DAEMON_SESSION_INVENTORY: DaemonSessionInventory = {
  sessions: [],
  count: 0
}

export function inventoryFromSessions(sessions: readonly DaemonSession[]): DaemonSessionInventory {
  return {
    sessions: sessions.slice(),
    count: sessions.length
  }
}

export function removeSessionsFromInventory(
  inventory: DaemonSessionInventory,
  sessionIds: ReadonlySet<string>
): DaemonSessionInventory {
  if (sessionIds.size === 0 || inventory.sessions.length === 0) {
    return inventory
  }
  const sessions = inventory.sessions.filter((session) => !sessionIds.has(session.id))
  if (sessions.length === inventory.sessions.length) {
    return inventory
  }
  return {
    sessions,
    count: sessions.length
  }
}

export function removeSessionFromInventory(
  inventory: DaemonSessionInventory,
  sessionId: string
): DaemonSessionInventory {
  return removeSessionsFromInventory(inventory, new Set([sessionId]))
}

function sameListedSession(before: DaemonSession, after: DaemonSession): boolean {
  return (
    before === after ||
    (before.id === after.id &&
      before.incarnationId === after.incarnationId &&
      before.inventorySourceId === after.inventorySourceId &&
      before.routed === after.routed &&
      before.fencedTermination === after.fencedTermination &&
      before.idleFencedTermination === after.idleFencedTermination &&
      before.rootProcessId === after.rootProcessId &&
      before.foregroundProcess === after.foregroundProcess &&
      before.cwd === after.cwd &&
      before.title === after.title &&
      before.worktreeId === after.worktreeId &&
      before.paneKey === after.paneKey &&
      before.agentOwnership === after.agentOwnership &&
      before.exiting === after.exiting)
  )
}

type ListedIncarnation = {
  listing: number
  firstIdentity: string
  identities: Set<string>
}

export type ListedIncarnations = Map<string, ListedIncarnation>

export function reconcileResourceSessionListing(
  sessions: readonly DaemonSession[],
  previous: ReadonlyMap<string, DaemonSession>,
  incarnations: ListedIncarnations,
  listing: number,
  tombstones: ReadonlySet<string>,
  { compareExisting, trackRemovals }: { compareExisting: boolean; trackRemovals: boolean }
) {
  const deduped = new Map<string, DaemonSession>()
  const previousAliases = new Map<string, ReadonlySet<string>>()
  let pendingRefresh = false
  let retained = 0
  let observedIncarnations = 0
  for (const session of sessions) {
    const identity = ptySessionIdentity(session)
    const incarnation = ptySessionIdentity({
      id: session.id,
      incarnationId: session.incarnationId
    })
    let entry = incarnations.get(incarnation)
    if (entry?.listing !== listing) {
      observedIncarnations += 1
      if (trackRemovals && entry) {
        if (entry.firstIdentity === identity || entry.identities.has(identity)) {
          retained += 1
        }
        if (entry.identities.size > 1 || entry.firstIdentity !== identity) {
          previousAliases.set(incarnation, entry.identities)
        }
      }
      entry = { listing, firstIdentity: identity, identities: new Set() }
      incarnations.set(incarnation, entry)
    } else if (
      trackRemovals &&
      !entry.identities.has(identity) &&
      previousAliases.get(incarnation)?.has(identity)
    ) {
      retained += 1
    }
    entry.identities.add(identity)
    deduped.set(identity, session)
  }
  for (const incarnation of tombstones) {
    const entry = incarnations.get(incarnation)
    if (entry?.listing !== listing) {
      continue
    }
    if (entry.identities.size > 1) {
      pendingRefresh = true
      continue
    }
    deduped.delete(entry.firstIdentity)
    incarnations.delete(incarnation)
    observedIncarnations -= 1
    if (trackRemovals && previous.has(entry.firstIdentity)) {
      retained -= 1
    }
  }
  // The existing incarnation lookup tracks membership as rows arrive, so additions need no old-map walk.
  if (observedIncarnations < incarnations.size) {
    for (const [incarnation, entry] of incarnations) {
      if (entry.listing !== listing) {
        incarnations.delete(incarnation)
      }
    }
  }
  let unchanged = false
  if (compareExisting && deduped.size === previous.size) {
    const old = previous.values()
    unchanged = deduped.values().every((session) => sameListedSession(old.next().value!, session))
  }
  return { deduped, unchanged, retained, pendingRefresh }
}
