import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DatabaseConnectionRequest,
  DatabaseQueryResult
} from '../../../../shared/database-types'
import { cancelDatabaseQuery, executeDatabaseQuery } from '@/runtime/runtime-database-client'

export const DATABASE_QUERY_ROW_LIMIT = 500

export function useDatabaseQuery({
  worktreeId,
  request,
  contextKey,
  queryDraft,
  readOnly,
  enabled,
  isActive
}: {
  worktreeId: string
  request: DatabaseConnectionRequest
  contextKey: string
  queryDraft: string
  readOnly: boolean
  enabled: boolean
  isActive: boolean
}) {
  const [result, setResult] = useState<DatabaseQueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<{ sql: string; at: number; readOnly: boolean } | null>(
    null
  )
  const [previousContext, setPreviousContext] = useState(contextKey)
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const lifecycle = useRef<{
    pending: { id: string; cancelled: boolean } | null
    generation: number
    mounted: boolean
  }>({ pending: null, generation: 0, mounted: true }).current
  const currentContext = useRef(contextKey)
  currentContext.current = contextKey

  const cancel = useCallback(async () => {
    setRefreshSeconds(0)
    const pending = lifecycle.pending
    if (!pending) {
      return
    }
    pending.cancelled = true
    await cancelDatabaseQuery(worktreeId, request.connection.providerId, pending.id).catch(
      () => false
    )
  }, [worktreeId, request.connection.providerId, lifecycle])

  const reset = useCallback(() => {
    const pending = lifecycle.pending
    if (pending) {
      pending.cancelled = true
      void cancelDatabaseQuery(worktreeId, request.connection.providerId, pending.id).catch(
        () => false
      )
    }
    lifecycle.generation++
    setResult(null)
    setLastRun(null)
    setError(null)
    setRefreshSeconds(0)
  }, [worktreeId, request.connection.providerId, lifecycle])

  if (previousContext !== contextKey) {
    setPreviousContext(contextKey)
    setResult(null)
    setLastRun(null)
    setError(null)
    setRefreshSeconds(0)
  }
  useEffect(() => {
    lifecycle.generation++
    const pending = lifecycle.pending
    if (pending) {
      pending.cancelled = true
      void cancelDatabaseQuery(worktreeId, request.connection.providerId, pending.id).catch(
        () => false
      )
    }
  }, [contextKey, lifecycle, worktreeId, request.connection.providerId])

  useEffect(() => {
    const update = (): void => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    lifecycle.mounted = true
    return () => {
      lifecycle.mounted = false
      lifecycle.generation++
      const pending = lifecycle.pending
      if (pending) {
        pending.cancelled = true
        void cancelDatabaseQuery(worktreeId, request.connection.providerId, pending.id).catch(
          () => false
        )
      }
    }
  }, [worktreeId, request.connection.providerId, lifecycle])

  const run = useCallback(
    async (sqlOverride?: string, forceReadOnly = false): Promise<void> => {
      const sql = (sqlOverride ?? queryDraft).trim()
      if (!enabled || !sql || lifecycle.pending) {
        return
      }
      const pending = { id: crypto.randomUUID(), cancelled: false }
      const version = lifecycle.generation
      const submittedReadOnly = forceReadOnly || readOnly
      lifecycle.pending = pending
      setRunning(true)
      setError(null)
      try {
        const next = await executeDatabaseQuery(worktreeId, {
          ...request,
          queryId: pending.id,
          sql,
          readOnly: submittedReadOnly,
          maxRows: DATABASE_QUERY_ROW_LIMIT,
          timeoutMs: 30_000
        })
        if (
          !lifecycle.mounted ||
          version !== lifecycle.generation ||
          contextKey !== currentContext.current ||
          pending.cancelled
        ) {
          return
        }
        setResult(next)
        setLastRun({ sql, at: Date.now(), readOnly: submittedReadOnly })
      } catch (caught) {
        if (
          lifecycle.mounted &&
          version === lifecycle.generation &&
          contextKey === currentContext.current &&
          !pending.cancelled
        ) {
          setError(caught instanceof Error ? caught.message : String(caught))
          setRefreshSeconds(0)
        }
      } finally {
        if (lifecycle.pending === pending) {
          lifecycle.pending = null
        }
        if (lifecycle.mounted) {
          setRunning(false)
        }
      }
    },
    [enabled, queryDraft, readOnly, request, worktreeId, contextKey, lifecycle]
  )

  const canRefresh = Boolean(
    enabled && readOnly && lastRun?.readOnly && lastRun.sql === queryDraft.trim()
  )
  if (!canRefresh && refreshSeconds !== 0) {
    setRefreshSeconds(0)
  }
  useEffect(() => {
    if (!canRefresh || running || !isActive || !documentVisible || refreshSeconds === 0) {
      return
    }
    const timer = window.setTimeout(() => void run(), refreshSeconds * 1000)
    return () => window.clearTimeout(timer)
  }, [canRefresh, running, isActive, documentVisible, refreshSeconds, run, lastRun])

  return {
    result,
    error,
    running,
    lastRun,
    refreshSeconds,
    setRefreshSeconds,
    canRefresh,
    run,
    cancel,
    reset
  }
}
