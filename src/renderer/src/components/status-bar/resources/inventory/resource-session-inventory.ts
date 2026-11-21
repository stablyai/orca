import type { PtyListedSession as DaemonSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'

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

export function sameListedSession(before: DaemonSession, after: DaemonSession): boolean {
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
