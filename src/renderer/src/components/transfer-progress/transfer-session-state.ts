// `unconfirmed` is a cancel whose result never came back, so the remote state is unknown.
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
  totalBytes: number
  status: TransferRowStatus
  kind?: 'file' | 'directory'
}

export type TransferSession = {
  sessionId: string
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

export function startTransferSession(sessionId: string, rows: TransferRow[]): void {
  sessions.set(sessionId, { sessionId, rows, settled: false, collapsed: false })
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

// Why: swapped, not mutated, so `useSyncExternalStore` sees a new reference.
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
    // Why: an in-flight progress event must not drag a settled row back.
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
  percent: number
  activeCount: number
  doneCount: number
  cancelledCount: number
} {
  let sentBytes = 0
  let totalBytes = 0
  let activeCount = 0
  let doneCount = 0
  let cancelledCount = 0
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
    sentBytes += Math.min(row.sentBytes, row.totalBytes)
    totalBytes += row.totalBytes
    if (row.status === 'active' || row.status === 'cancelling' || row.status === 'unconfirmed') {
      activeCount += 1
    }
  }
  return {
    sentBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : 0,
    activeCount,
    doneCount,
    cancelledCount
  }
}
