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

export function reconcileResourceSessionListing(
  sessions: readonly DaemonSession[],
  previous: ReadonlyMap<string, DaemonSession>,
  tombstones: ReadonlySet<string>,
  { compareExisting, trackRemovals }: { compareExisting: boolean; trackRemovals: boolean }
) {
  const deduped = new Map<string, DaemonSession>()
  const identitiesByIncarnation = new Map<string, Set<string>>()
  const previousEntries = previous.entries()
  let nextPrevious = previousEntries.next()
  let unchanged = compareExisting && sessions.length === previous.size
  let pendingRefresh = false
  let retained = 0
  for (const session of sessions) {
    const identity = ptySessionIdentity(session)
    const incarnation = ptySessionIdentity({
      id: session.id,
      incarnationId: session.incarnationId
    })
    const priorSize = deduped.size
    deduped.set(identity, session)
    if (deduped.size === priorSize) {
      unchanged = false
    } else if (trackRemovals || unchanged) {
      if (!nextPrevious.done && nextPrevious.value[0] === identity) {
        retained += 1
        unchanged &&= sameListedSession(nextPrevious.value[1], session)
        nextPrevious = previousEntries.next()
      } else {
        unchanged = false
        // An append needs no lookup once the previous order has been consumed.
        if (trackRemovals && !nextPrevious.done && previous.has(identity)) {
          retained += 1
        }
      }
    }
    const identities = identitiesByIncarnation.get(incarnation) ?? new Set<string>()
    identities.add(identity)
    identitiesByIncarnation.set(incarnation, identities)
  }
  for (const [incarnation, identities] of identitiesByIncarnation) {
    if (!tombstones.has(incarnation)) {
      continue
    }
    if (identities.size > 1) {
      pendingRefresh = true
      continue
    }
    for (const identity of identities) {
      deduped.delete(identity)
      if (trackRemovals && previous.has(identity)) {
        retained -= 1
      }
    }
    identitiesByIncarnation.delete(incarnation)
  }
  if (
    compareExisting &&
    !unchanged &&
    sessions.length !== deduped.size &&
    deduped.size === previous.size
  ) {
    const old = previous.values()
    unchanged = deduped.values().every((session) => sameListedSession(old.next().value!, session))
  }
  return { deduped, identitiesByIncarnation, unchanged, retained, pendingRefresh }
}
