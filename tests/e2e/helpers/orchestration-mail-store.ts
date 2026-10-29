// Read SQLite out of band: orchestration.check consumes rows and backfills delivered_at, destroying the distinction under test.
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from '../../../src/main/sqlite/sync-database'

export type MailRow = {
  id: string
  run_id: string
  delivery_contract: string
  type: string
  to_handle: string
  subject: string
  read: number
  delivered_at: string | null
  pointer_enter_pending: number
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
      .prepare(
        `SELECT id, run_id, delivery_contract, type, to_handle, subject, read, delivered_at,
                pointer_enter_pending
         FROM messages WHERE id = ?`
      )
      .get(id)
  ) as MailRow | undefined
}

export function readMailbox(userDataDir: string, toHandle: string): MailRow[] {
  return withMailDb(userDataDir, (db) =>
    db
      .prepare(
        `SELECT id, run_id, delivery_contract, type, to_handle, subject, read, delivered_at,
                pointer_enter_pending
         FROM messages WHERE to_handle = ? ORDER BY sequence`
      )
      .all(toHandle)
  ) as MailRow[]
}

export function insertDirectRunMail(
  userDataDir: string,
  params: { runId: string; toHandle: string; subject: string }
): string {
  const id = `msg_e2e_${randomUUID()}`
  withMailDb(userDataDir, (db) => {
    db.prepare(
      `INSERT INTO messages (
         id, run_id, delivery_contract, from_handle, to_handle, subject, type
       ) VALUES (?, ?, 'current_delivery', 'e2e-worker', ?, ?, 'status')`
    ).run(id, params.runId, params.toHandle, params.subject)
  })
  return id
}

// Seed a legacy running coordinator directly; orchestration.run would introduce scheduler races.
export function startCoordinatorRun(userDataDir: string, handle: string): void {
  withMailDb(userDataDir, (db) => {
    db.prepare(
      `INSERT INTO coordinator_runs (id, spec, status, coordinator_handle)
       VALUES (?, 'e2e coordinator Enter carve-out', 'running', ?)`
    ).run(`e2e-coordinator-${handle}`, handle)
  })
}

// Check read first: pulls backfill delivered_at too, so a delivery stamp alone does not prove push.
export function mailDisposition(row: MailRow | undefined): MailDisposition | 'missing' {
  if (!row) {
    return 'missing'
  }
  if (row.read === 1) {
    return 'pulled'
  }
  return row.delivered_at === null ? 'pending' : 'pushed'
}
