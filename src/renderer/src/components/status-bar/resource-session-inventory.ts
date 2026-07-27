import type { DaemonSession } from './resource-usage-merge-types'

/** Last-known daemon terminal inventory for the Resource Manager badge. */
export type DaemonSessionInventory = {
  sessionIds: string[]
  sessions: DaemonSession[]
  count: number
}

export const EMPTY_DAEMON_SESSION_INVENTORY: DaemonSessionInventory = {
  sessionIds: [],
  sessions: [],
  count: 0
}

export function inventoryFromSessions(sessions: readonly DaemonSession[]): DaemonSessionInventory {
  const deduped = new Map(sessions.map((session) => [session.id, session]))
  return {
    sessionIds: Array.from(deduped.keys()),
    sessions: Array.from(deduped.values()),
    count: deduped.size
  }
}

export function inventoryFromSessionIds(sessionIds: readonly string[]): DaemonSessionInventory {
  const uniqueIds = Array.from(new Set(sessionIds))
  return {
    sessionIds: uniqueIds,
    sessions: [],
    count: uniqueIds.length
  }
}

export function removeSessionsFromInventory(
  inventory: DaemonSessionInventory,
  sessionIds: ReadonlySet<string>
): DaemonSessionInventory {
  if (sessionIds.size === 0 || inventory.sessionIds.length === 0) {
    return inventory
  }
  const retainedIds = inventory.sessionIds.filter((id) => !sessionIds.has(id))
  const sessions = inventory.sessions.filter((session) => !sessionIds.has(session.id))
  if (retainedIds.length === inventory.sessionIds.length) {
    return inventory
  }
  return {
    sessionIds: retainedIds,
    sessions,
    count: retainedIds.length
  }
}

export function removeSessionFromInventory(
  inventory: DaemonSessionInventory,
  sessionId: string
): DaemonSessionInventory {
  return removeSessionsFromInventory(inventory, new Set([sessionId]))
}
