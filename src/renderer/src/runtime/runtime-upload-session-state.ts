export type RuntimeUploadRowStatus = 'uploading' | 'done' | 'cancelled' | 'failed'

export type RuntimeUploadRow = {
  /** Id every file of one dropped source streams under; also the cancel handle. */
  uploadId: string
  name: string
  sentBytes: number
  totalBytes: number
  status: RuntimeUploadRowStatus
}

export type RuntimeUploadSession = {
  sessionId: string
  rows: RuntimeUploadRow[]
  /** Every row has stopped moving; the panel shows its outcome, then leaves. */
  settled: boolean
  /** Kept here, not in the panel: toggling it remounts the panel to re-measure. */
  collapsed: boolean
}

type Listener = () => void

const sessions = new Map<string, RuntimeUploadSession>()
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeToRuntimeUploadSessions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getRuntimeUploadSession(sessionId: string): RuntimeUploadSession | undefined {
  return sessions.get(sessionId)
}

export function startRuntimeUploadSession(sessionId: string, rows: RuntimeUploadRow[]): void {
  sessions.set(sessionId, { sessionId, rows, settled: false, collapsed: false })
  emit()
}

/** Keeps the rows so the panel can state how the drop ended before it closes. */
export function settleRuntimeUploadSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.settled) {
    return
  }
  sessions.set(sessionId, { ...session, settled: true })
  emit()
}

export function toggleRuntimeUploadCollapsed(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  sessions.set(sessionId, { ...session, collapsed: !session.collapsed })
  emit()
}

export function endRuntimeUploadSession(sessionId: string): void {
  sessions.delete(sessionId)
  emit()
}

/**
 * Replace one row.
 *
 * Rows are swapped rather than mutated so `useSyncExternalStore` sees a new
 * reference; mutating in place renders a stale bar that never moves.
 */
export function updateRuntimeUploadRow(
  sessionId: string,
  uploadId: string,
  patch: Partial<Omit<RuntimeUploadRow, 'uploadId'>>
): void {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  let changed = false
  const rows = session.rows.map((row) => {
    if (row.uploadId !== uploadId) {
      return row
    }
    // Why: a cancelled or failed row must not be dragged back to 'uploading' by
    // a progress event that was already in flight when the user clicked.
    if (row.status !== 'uploading') {
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

export function summarizeRuntimeUploadSession(session: RuntimeUploadSession): {
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
    if (row.status === 'uploading') {
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
