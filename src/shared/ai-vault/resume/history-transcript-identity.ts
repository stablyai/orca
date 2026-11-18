import type { HistoryContinuation } from './history-resume-accounts'
import { normalizeRuntimePathForComparison } from '../../file-access/cross-platform-path'

export function historyTranscriptKey(provider: string, filePath: string): string {
  return JSON.stringify([provider, normalizeRuntimePathForComparison(filePath)])
}

export function historyContinuationRootKey(
  entry: HistoryContinuation,
  entries: readonly HistoryContinuation[]
): string {
  if (entry.rootTranscriptKey) {
    return entry.rootTranscriptKey
  }
  const roots = entries.filter(
    (row) =>
      row.provider === entry.provider &&
      row.sessionId === entry.rootSessionId &&
      !row.parentSessionId
  )
  return roots.length === 1
    ? historyTranscriptKey(entry.provider, roots[0].filePath)
    : historyTranscriptKey(entry.provider, entry.filePath)
}
