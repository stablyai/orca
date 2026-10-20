import { useMemo } from 'react'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { useAiVaultSessionRefresh } from '../right-sidebar/ai-vault-session-refresh'
import { buildSessionsBoardColumns, type SessionsBoardColumn } from './sessions-board-column-model'

// Why: a stable identity, because the scan hook keys its cache on the scope it was
// handed and a fresh `[]` each render would read as a new scope.
const MACHINE_WIDE_SCOPE_PATHS: readonly string[] = []

export type SessionsBoardData = {
  columns: SessionsBoardColumn[]
  /** The unfiltered scan, newest-first. Card availability re-derives from this array's
   *  identity, so it must never be a per-keystroke projection of `columns`. */
  sessions: readonly AiVaultSession[]
  loading: boolean
  error: string | null
  scanIssues: number
  refresh: (args?: { force?: boolean; background?: boolean }) => Promise<void>
}

export function useSessionsBoardColumns(filters: {
  query: string
  hideEmptySessions: boolean
}): SessionsBoardData {
  // Why 'unlimited': the scanner's 1000 default is a cap across all agents, not per
  // agent, so any finite depth silently truncates a large history. The first scan is
  // cold by design — a 250-deep cached result can never satisfy this request.
  const { sessions, loading, error, scanResult, refresh } = useAiVaultSessionRefresh(
    MACHINE_WIDE_SCOPE_PATHS,
    ALL_EXECUTION_HOSTS_SCOPE,
    'unlimited'
  )
  const { query, hideEmptySessions } = filters
  const columns = useMemo(
    () => buildSessionsBoardColumns(sessions, { query, hideEmptySessions }),
    [sessions, query, hideEmptySessions]
  )
  return {
    columns,
    sessions,
    loading,
    error,
    scanIssues: scanResult?.issues.length ?? 0,
    refresh
  }
}
