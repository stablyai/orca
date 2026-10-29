import { useCallback, useEffect, useRef, useState } from 'react'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RunEventsPage } from '../../../../shared/orchestration-run-events'

export type HistoryPage<Row> = {
  rows: Row[]
  nextCursor: string | null
  coverage?: RunEventsPage['coverage']
}
export type HistoryError = 'unsupported' | 'expired' | 'failed'
export type HistoryPages<Row> = HistoryPage<Row> & {
  loading: boolean
  loadingVisible: boolean
  error: HistoryError | null
}

type Request = { controller: AbortController; timer?: ReturnType<typeof setTimeout> }

export function useRunHistoryPages<Row>(
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<HistoryPage<Row>>
) {
  const [page, setPage] = useState<HistoryPages<Row>>({
    rows: [],
    nextCursor: null,
    loading: true,
    loadingVisible: false,
    error: null
  })
  const pending = useRef<Request | null>(null)
  const failedCursor = useRef<string | undefined>(undefined)
  const cancel = useCallback(() => {
    pending.current?.controller.abort()
    clearTimeout(pending.current?.timer)
    pending.current = null
  }, [])
  const request = useCallback(
    (cursor?: string) => {
      if (pending.current) {
        return
      }
      const active: Request = { controller: new AbortController() }
      pending.current = active
      setPage((previous) => ({
        ...(cursor ? previous : { rows: [], nextCursor: null }),
        loading: true,
        loadingVisible: false,
        error: null
      }))
      active.timer = setTimeout(() => {
        if (pending.current === active) {
          setPage((previous) => ({ ...previous, loadingVisible: true }))
        }
      }, 200)
      void loadPage(cursor, active.controller.signal)
        .then(
          (result) => {
            if (pending.current !== active) {
              return
            }
            setPage((previous) => ({
              ...result,
              rows: cursor ? [...previous.rows, ...result.rows] : result.rows,
              loading: false,
              loadingVisible: false,
              error: null
            }))
          },
          (error: unknown) => {
            if (pending.current !== active) {
              return
            }
            failedCursor.current = cursor
            const kind: HistoryError =
              error instanceof RuntimeRpcCallError
                ? error.code === 'method_not_found'
                  ? 'unsupported'
                  : error.code === 'cursor_invalid'
                    ? 'expired'
                    : 'failed'
                : 'failed'
            setPage((previous) => ({
              ...previous,
              loading: false,
              loadingVisible: false,
              error: kind
            }))
          }
        )
        .finally(() => {
          clearTimeout(active.timer)
          if (pending.current === active) {
            pending.current = null
          }
        })
    },
    [loadPage]
  )

  useEffect(() => {
    request()
    return cancel
  }, [request, cancel])

  return {
    ...page,
    refresh: () => {
      cancel()
      request()
    },
    retry: () => request(failedCursor.current),
    loadMore: () => {
      if (page.nextCursor) {
        request(page.nextCursor)
      }
    }
  }
}
