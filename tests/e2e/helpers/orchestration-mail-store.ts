/**
 * Direct reads of the orchestration mailbox for E2E assertions.
 *
 * Why read SQLite instead of `orchestration.check`: check is itself a consumer —
 * it marks rows read and backfills `delivered_at` — so using it to observe would
 * destroy the very distinction these specs exist to test. The two markers are
 * independent on purpose: `delivered_at` means a push typed the row into a pane,
 * `read` means a pull consumed it. Only an out-of-band read can tell them apart.
 */
import path from 'node:path'
import Database from '../../../src/main/sqlite/sync-database'

export type MailRow = {
  id: string
  type: string
  to_handle: string
  subject: string
  read: number
  delivered_at: string | null
}

export type MailDisposition = 'pending' | 'pushed' | 'pulled'

function withMailDb<T>(userDataDir: string, read: (db: Database) => T): T {
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

export function readMailRow(userDataDir: string, id: string): MailRow | undefined {
  return withMailDb(userDataDir, (db) =>
    db
      .prepare('SELECT id, type, to_handle, subject, read, delivered_at FROM messages WHERE id = ?')
      .get(id)
  ) as MailRow | undefined
}

export function readMailbox(userDataDir: string, toHandle: string): MailRow[] {
  return withMailDb(userDataDir, (db) =>
    db
      .prepare(
        'SELECT id, type, to_handle, subject, read, delivered_at FROM messages WHERE to_handle = ? ORDER BY sequence'
      )
      .all(toHandle)
  ) as MailRow[]
}

/**
 * Mark `handle` as the running coordinator — the state that makes push delivery
 * withhold the synthesized Enter, because that prompt holds user-typed input.
 *
 * Why seed the row instead of calling `orchestration.run`: that RPC also starts
 * a live coordinator loop which dispatches workers on a timer, and its
 * scheduling would race every assertion here. The carve-out reads nothing but
 * this row.
 */
export function startCoordinatorRun(userDataDir: string, handle: string): void {
  withMailDb(userDataDir, (db) => {
    db.prepare(
      `INSERT INTO coordinator_runs (id, spec, status, coordinator_handle)
       VALUES (?, 'e2e coordinator Enter carve-out', 'running', ?)`
    ).run(`e2e-coordinator-${handle}`, handle)
  })
}

/**
 * How a row was consumed, if at all.
 *
 * `read` is checked first because a pull backfills `delivered_at` via COALESCE,
 * so a pulled row also carries a delivery stamp — the stamp alone cannot prove
 * a push happened.
 */
export function mailDisposition(row: MailRow | undefined): MailDisposition | 'missing' {
  if (!row) {
    return 'missing'
  }
  if (row.read === 1) {
    return 'pulled'
  }
  return row.delivered_at === null ? 'pending' : 'pushed'
}
