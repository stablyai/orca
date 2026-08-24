import type { DaemonSession } from './resource-usage-merge-types'

/** Last-known daemon terminal inventory exposed to Resource Usage consumers. */
export type DaemonSessionInventory = {
  sessions: DaemonSession[]
  count: number
}

export const EMPTY_DAEMON_SESSION_ROWS: DaemonSession[] = []

export const EMPTY_DAEMON_SESSION_INVENTORY: DaemonSessionInventory = {
  sessions: EMPTY_DAEMON_SESSION_ROWS,
  count: 0
}

/** Mutable row index owned by one inventory hook instance. Lifecycle removals are O(1). */
export class ResourceSessionInventoryRows {
  private rowsById = new Map<string, DaemonSession>()

  replace(sessions: readonly DaemonSession[]): void {
    this.rowsById = new Map(sessions.map((session) => [session.id, session]))
  }

  remove(sessionId: string): boolean {
    return this.rowsById.delete(sessionId)
  }

  removeMany(sessionIds: ReadonlySet<string>): number {
    let removed = 0
    for (const sessionId of sessionIds) {
      if (this.rowsById.delete(sessionId)) {
        removed += 1
      }
    }
    return removed
  }

  clear(): void {
    this.rowsById.clear()
  }

  toArray(): DaemonSession[] {
    return Array.from(this.rowsById.values())
  }
}
