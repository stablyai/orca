// Loads the team audit log for Settings › Enterprise: the first page, more pages, filter changes
// and the CSV export. The control plane decides access; `plan-required` becomes the upsell.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudAuditActor,
  CloudAuditEvent
} from '../../../../../shared/cloud-api/cloud-api-types'
import { cloudApiErrorCopy } from '../cloud-api/cloud-api-copy'
import type { CloudApiFailure } from '../cloud-api/cloud-load-state'
import { useRequestGeneration } from '../cloud-api/use-request-generation'
import type { AuditLogExportState, AuditLogFilters, AuditLogState } from './EnterpriseAuditLog'

const PAGE_SIZE = 50
const NO_FILTERS: AuditLogFilters = { category: null, actor: null }

function queryFor(filters: AuditLogFilters): {
  category?: NonNullable<AuditLogFilters['category']>
  actor?: string
} {
  return {
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.actor ? { actor: filters.actor } : {})
  }
}

/** Hands the CSV to the browser's download path (Electron shows its save dialog). */
export function saveAuditCsv(csv: string, at: number): void {
  // A BOM so spreadsheet apps read names with accents as UTF-8.
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `orca-audit-log-${new Date(at).toISOString().slice(0, 10)}.csv`
  document.body.append(link)
  link.click()
  link.remove()
  // Revoked after the click has been handled, or the download can start from a dead URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function useEnterpriseAuditLog(enabled: boolean): {
  log: AuditLogState
  filters: AuditLogFilters
  actors: CloudAuditActor[]
  exportState: AuditLogExportState
  now: number
  setFilters: (filters: AuditLogFilters) => void
  loadMore: () => void
  retry: () => void
  exportCsv: () => void
} {
  const t = useTranslate()
  const api = window.api.cloudApi
  const begin = useRequestGeneration()
  const [log, setLog] = useState<AuditLogState>({ status: 'loading' })
  const [filters, setFiltersState] = useState<AuditLogFilters>(NO_FILTERS)
  const [actors, setActors] = useState<CloudAuditActor[]>([])
  const [exportState, setExportState] = useState<AuditLogExportState>({ status: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const cursor = useRef<string | null>(null)
  const loaded = useRef<CloudAuditEvent[]>([])

  const word = useCallback(
    (failure: CloudApiFailure) => cloudApiErrorCopy(failure.error, t, failure),
    [t]
  )

  const loadFirst = useCallback(
    async (next: AuditLogFilters): Promise<void> => {
      if (!api) {
        return
      }
      const isCurrent = begin('audit-log')
      // A filter change keeps the list on screen until the new one arrives.
      setLog((current) =>
        current.status === 'ok' ? { ...current, refreshing: true } : { status: 'loading' }
      )
      const result = await api.listAuditLog({ ...queryFor(next), limit: PAGE_SIZE })
      if (!isCurrent()) {
        return
      }
      setNow(Date.now())
      if (!result.ok) {
        cursor.current = null
        loaded.current = []
        setLog(
          result.error === 'plan-required'
            ? { status: 'upsell' }
            : { status: 'error', message: word(result) }
        )
        return
      }
      cursor.current = result.data.nextCursor
      loaded.current = result.data.events
      if (result.data.actors) {
        setActors(result.data.actors)
      }
      setLog({
        status: 'ok',
        events: result.data.events,
        hasMore: result.data.nextCursor !== null,
        loadingMore: false,
        moreError: null,
        refreshing: false
      })
    },
    [api, begin, word]
  )

  useEffect(() => {
    if (enabled) {
      void loadFirst(NO_FILTERS)
    }
  }, [enabled, loadFirst])

  const setFilters = useCallback(
    (next: AuditLogFilters): void => {
      setFiltersState(next)
      setExportState({ status: 'idle' })
      void loadFirst(next)
    },
    [loadFirst]
  )

  const loadMore = useCallback((): void => {
    const after = cursor.current
    if (!api || !after) {
      return
    }
    const isCurrent = begin('audit-log')
    setLog((current) =>
      current.status === 'ok' ? { ...current, loadingMore: true, moreError: null } : current
    )
    void api
      .listAuditLog({ ...queryFor(filters), cursor: after, limit: PAGE_SIZE })
      .then((result) => {
        if (!isCurrent()) {
          return
        }
        if (!result.ok) {
          setLog((current) =>
            current.status === 'ok'
              ? { ...current, loadingMore: false, moreError: word(result) }
              : current
          )
          return
        }
        cursor.current = result.data.nextCursor
        // A new event can shift a page boundary; never show one twice.
        const seen = new Set(loaded.current.map((event) => event.id))
        loaded.current = [
          ...loaded.current,
          ...result.data.events.filter((event) => !seen.has(event.id))
        ]
        setLog({
          status: 'ok',
          events: loaded.current,
          hasMore: result.data.nextCursor !== null,
          loadingMore: false,
          moreError: null,
          refreshing: false
        })
      })
  }, [api, begin, filters, word])

  const exportCsv = useCallback((): void => {
    if (!api) {
      return
    }
    const isCurrent = begin('audit-export')
    setExportState({ status: 'exporting' })
    void api.exportAuditLogCsv(queryFor(filters)).then((result) => {
      if (!isCurrent()) {
        return
      }
      if (!result.ok) {
        setExportState({ status: 'error', message: word(result) })
        return
      }
      saveAuditCsv(result.data.csv, Date.now())
      setExportState({ status: 'done', truncated: result.data.truncated })
    })
  }, [api, begin, filters, word])

  return {
    log,
    filters,
    actors,
    exportState,
    now,
    setFilters,
    loadMore,
    retry: () => void loadFirst(filters),
    exportCsv
  }
}
