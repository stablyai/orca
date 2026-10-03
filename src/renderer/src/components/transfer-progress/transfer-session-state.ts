export type TransferDirection = 'upload' | 'download'

/**
 * `cancelling` holds from the click until the transfer's own result says how it ended;
 * `unconfirmed` is a cancel whose result never came back, so the remote state is unknown.
 */
export type TransferRowStatus =
  | 'active'
  | 'cancelling'
  | 'unconfirmed'
  | 'done'
  | 'cancelled'
  | 'failed'

export type TransferRow = {
  /** Id every file of one source moves under; also the cancel handle. */
  transferId: string
  name: string
  sentBytes: number
  /** 0 while unknown (not yet measured, or the size lookup failed). */
  totalBytes: number
  status: TransferRowStatus
  kind?: 'file' | 'directory'
  /** What a rollback could not undo on the host (full reason, shown as the row's tooltip). */
  detail?: string
}

export type TransferSession = {
  sessionId: string
  direction: TransferDirection
  rows: TransferRow[]
  /** Every row has stopped moving; the panel shows its outcome, then leaves. */
  settled: boolean
  /** Kept here, not in the panel: toggling it remounts the panel to re-measure. */
  collapsed: boolean
}

type Listener = () => void

const sessions = new Map<string, TransferSession>()
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeToTransferSessions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTransferSession(sessionId: string): TransferSession | undefined {
  return sessions.get(sessionId)
}

export function startTransferSession(
  sessionId: string,
  direction: TransferDirection,
  rows: TransferRow[]
): void {
  sessions.set(sessionId, { sessionId, direction, rows, settled: false, collapsed: false })
  emit()
}

/** Keeps the rows so the panel can state how the drop ended before it closes. */
export function settleTransferSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.settled) {
    return
  }
  sessions.set(sessionId, { ...session, settled: true })
  emit()
}

export function toggleTransferCollapsed(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  sessions.set(sessionId, { ...session, collapsed: !session.collapsed })
  emit()
}

export function endTransferSession(sessionId: string): void {
  sessions.delete(sessionId)
  emit()
}

/**
 * Replace one row.
 *
 * Rows are swapped rather than mutated so `useSyncExternalStore` sees a new
 * reference; mutating in place renders a stale bar that never moves.
 */
export function updateTransferRow(
  sessionId: string,
  transferId: string,
  patch: Partial<Omit<TransferRow, 'transferId'>>
): void {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  let changed = false
  const rows = session.rows.map((row) => {
    if (row.transferId !== transferId) {
      return row
    }
    // Why: a settled row must not be dragged back by a progress event that was
    // already in flight; a cancelling row still moves and still takes its outcome.
    if (row.status !== 'active' && row.status !== 'cancelling' && row.status !== 'unconfirmed') {
      return row
    }
    if (row.status !== 'active' && patch.status === 'active') {
      return row
    }
    if (row.status === 'unconfirmed' && patch.status === 'cancelling') {
      return row
    }
    changed = true
    return { ...row, ...patch }
  })
  if (!changed) {
    return
  }
  sessions.set(sessionId, { ...session, rows })
  emit()
}

export function summarizeTransferSession(session: TransferSession): {
  sentBytes: number
  totalBytes: number
  /** Null while any moving row has no known total, so the header cannot claim a percentage. */
  percent: number | null
  activeCount: number
  doneCount: number
  cancelledCount: number
} {
  let sentBytes = 0
  let totalBytes = 0
  let activeCount = 0
  let doneCount = 0
  let cancelledCount = 0
  let unknownTotal = false
  // Why: bytes of a row with no total have no denominator; counting them in the
  // percentage would let a finished unknown-size row push the header to 100% early.
  let knownSentBytes = 0
  for (const row of session.rows) {
    if (row.status === 'done') {
      doneCount += 1
    }
    if (row.status === 'cancelled') {
      cancelledCount += 1
    }
    // Why: a cancelled row's remaining bytes are never going to move, so leaving
    // them in the denominator would strand the overall bar below 100%.
    if (row.status === 'cancelled' || row.status === 'failed') {
      continue
    }
    // Why: a row without a total still moved bytes; count them rather than zeroing the row.
    sentBytes += row.totalBytes > 0 ? Math.min(row.sentBytes, row.totalBytes) : row.sentBytes
    knownSentBytes += row.totalBytes > 0 ? Math.min(row.sentBytes, row.totalBytes) : 0
    totalBytes += row.totalBytes
    if (row.status === 'active' || row.status === 'cancelling' || row.status === 'unconfirmed') {
      activeCount += 1
      unknownTotal ||= row.totalBytes <= 0
    }
  }
  return {
    sentBytes,
    totalBytes,
    percent:
      unknownTotal || totalBytes <= 0
        ? null
        : Math.min(100, Math.floor((knownSentBytes / totalBytes) * 100)),
    activeCount,
    doneCount,
    cancelledCount
  }
}
