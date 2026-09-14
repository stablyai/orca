import { UNVERIFIED_PROCESS_EXIT_CODE } from './terminal-exit-cause'

export type RetiredPtyIncarnation = {
  incarnationId: string
  code: number
  expiresAt: number
}

/**
 * The code a tombstone records for a PTY the relay just retired.
 *
 * `'exited'` is ESRCH from the host that owns the pid — a proven death, recorded as `0` (no real
 * status exists, but a reader downstream gates on `isProvenProcessExit`, which only cares that the
 * code is non-negative). `'record-torn-down'` is our own bookkeeping saying we dropped the record —
 * not evidence the shell died — so it must record the unverified code and never masquerade as a
 * proven exit for a later `pty_exit_${code}` reader.
 */
export function resolveRetiredPtyIncarnationCode(evidence: 'exited' | 'record-torn-down'): number {
  return evidence === 'exited' ? 0 : UNVERIFIED_PROCESS_EXIT_CODE
}

const MAX_RETIRED_PTY_INCARNATIONS = 1000

/** Drop expired exit evidence and cap retained records during long-lived hosts. */
export function pruneRetiredPtyIncarnations(
  records: Map<string, RetiredPtyIncarnation>,
  now = Date.now()
): void {
  for (const [id, record] of records) {
    if (record.expiresAt <= now) {
      records.delete(id)
    }
  }
  while (records.size > MAX_RETIRED_PTY_INCARNATIONS) {
    const oldest = records.keys().next().value
    if (oldest === undefined) {
      break
    }
    records.delete(oldest)
  }
}
