import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import type { MaestroCanvasViewport } from './maestro-canvas-viewport'

export function useMaestroViewportPersistence(
  mutate: MaestroWorkspaceCanvasResource['mutate'],
  identity: string
) {
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitInFlightRef = useRef(false)
  const flushPendingRef = useRef<() => void>(() => {})
  const pendingCommitRef = useRef<{
    viewport: MaestroCanvasViewport
    mutate: MaestroWorkspaceCanvasResource['mutate']
    identity: string
  } | null>(null)

  const flush = useCallback((): void => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current)
    }
    commitTimerRef.current = null
    if (commitInFlightRef.current) {
      return
    }
    const pending = pendingCommitRef.current
    pendingCommitRef.current = null
    if (!pending) {
      return
    }
    commitInFlightRef.current = true
    void pending
      .mutate({
        action: 'set-viewport',
        viewport: pending.viewport,
        idempotency_key: `renderer-viewport-${pending.identity}-${crypto.randomUUID()}`
      })
      .finally(() => {
        commitInFlightRef.current = false
        if (pendingCommitRef.current) {
          flushPendingRef.current()
        }
      })
  }, [])
  flushPendingRef.current = flush
  useEffect(() => () => flush(), [flush, identity])

  const commit = useCallback(
    (viewport: MaestroCanvasViewport): void => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current)
      }
      pendingCommitRef.current = { viewport, mutate, identity }
      commitTimerRef.current = setTimeout(flush, 140)
    },
    [flush, identity, mutate]
  )
  const isBusy = useCallback(
    (): boolean => pendingCommitRef.current !== null || commitInFlightRef.current,
    []
  )

  return useMemo(() => ({ commit, isBusy }), [commit, isBusy])
}
