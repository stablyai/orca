export type CodexRolloutScope = {
  sessionId?: string
  historyStartOrdinal?: number
}

/** The first metadata row owns the file; forked history can contain a parent's metadata. */
export function acceptCodexRolloutRecord(
  scope: CodexRolloutScope,
  record: Record<string, unknown>
): boolean {
  if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    const payload = record.payload as Record<string, unknown>
    if (typeof payload.id === 'string') {
      if (scope.sessionId && scope.sessionId !== payload.id) {
        return false
      }
      if (!scope.sessionId) {
        scope.sessionId = payload.id
        const ordinal = payload.subagent_history_start_ordinal
        if (typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0) {
          scope.historyStartOrdinal = ordinal
        }
      }
      return true
    }
  }
  return (
    scope.historyStartOrdinal === undefined ||
    (typeof record.ordinal === 'number' &&
      Number.isSafeInteger(record.ordinal) &&
      record.ordinal >= scope.historyStartOrdinal)
  )
}
