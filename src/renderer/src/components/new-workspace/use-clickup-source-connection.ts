import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clickUpStatus } from '@/runtime/runtime-clickup-client'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { ClickUpConnectionStatus } from '../../../../shared/clickup-types'
import { getHostRuntimeContextKey } from '@/lib/provider-runtime-context'

export type ClickUpSourceConnection = {
  status: ClickUpConnectionStatus | null
  loaded: boolean
}

const UNLOADED_CONNECTION: ClickUpSourceConnection = { status: null, loaded: false }

export function useClickUpSourceConnection(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
}): ClickUpSourceConnection {
  const contextKey = useMemo(
    () => (args.sourceContext ? getTaskSourceCacheScope(args.sourceContext) : null),
    [args.sourceContext]
  )
  const revisionKey = useMemo(
    () => (args.sourceContext ? getHostRuntimeContextKey(args.sourceContext.hostId) : null),
    [args.sourceContext]
  )
  const loadKey = contextKey && revisionKey ? `${contextKey}::${revisionKey}` : null
  const sourceContextRef = useRef(args.sourceContext)
  useLayoutEffect(() => {
    sourceContextRef.current = args.sourceContext
  })
  const [state, setState] = useState<{
    loadKey: string | null
    status: ClickUpConnectionStatus | null
  }>({ loadKey: null, status: null })

  useEffect(() => {
    const sourceContext = sourceContextRef.current
    if (!args.enabled || !sourceContext || !loadKey) {
      return
    }
    let stale = false
    void clickUpStatus(sourceContext)
      .then((status) => {
        if (!stale) {
          setState({ loadKey, status })
        }
      })
      .catch(() => {
        if (!stale) {
          setState({ loadKey, status: { connected: false, viewer: null } })
        }
      })
    return () => {
      stale = true
    }
  }, [args.enabled, loadKey])

  return useMemo(
    () =>
      loadKey !== null && state.loadKey === loadKey
        ? { status: state.status, loaded: true }
        : UNLOADED_CONNECTION,
    [loadKey, state]
  )
}
