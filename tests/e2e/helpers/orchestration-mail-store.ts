/**
 * Direct reads of the orchestration mailbox for E2E assertions.
 *
 * Why read SQLite instead of `orchestration.check`: check is itself a consumer —
 * it marks rows read and backfills `delivered_at` — so using it to observe would
 * destroy the distinction these specs test. An out-of-band read proves pointer,
 * pending-Enter, and consumption state independently.
 */
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

export type ThreadedMailRow = Pick<MailRow, 'id' | 'run_id' | 'to_handle' | 'read'> & {
  thread_id: string | null
}

/** Exact rows, in insertion order, for asserting that a set of ids survived a restart unchanged. */
export function readMailRowsById(userDataDir: string, ids: string[]): ThreadedMailRow[] {
  if (ids.length === 0) {
    return []
  }
  return withMailDb(userDataDir, (db) =>
    db
      .prepare(
        `SELECT id, run_id, to_handle, read, thread_id FROM messages
         WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY sequence`
      )
      .all(...ids)
  ) as ThreadedMailRow[]
}

/**
 * How many Runs this database has adopted from a pre-cutover contract.
 *
 * A reopen that gains a row here means the skew probe read current state as
 * legacy state — the second half of the #19542 class of bug.
 */
export function countLegacyAdoptions(userDataDir: string): number {
  return withMailDb(
    userDataDir,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM legacy_adoptions').get() as { n: number }).n
  )
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

/**
 * Mark `handle` as a legacy running coordinator to prove it no longer suppresses Enter.
 *
 * Why seed instead of calling `orchestration.run`: that RPC starts a coordinator
 * loop whose scheduling would race the assertion.
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
 * How a row was consumed under either the current or historical push behavior.
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
