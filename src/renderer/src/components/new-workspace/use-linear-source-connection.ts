import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { linearStatus } from '@/runtime/runtime-linear-client'
import { useAppStore } from '@/store'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'

type LinearSourceConnection = {
  status: LinearConnectionStatus | null
  loaded: boolean
}

const UNLOADED_CONNECTION: LinearSourceConnection = { status: null, loaded: false }

export function useLinearSourceConnection(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
}): LinearSourceConnection {
  const scope = args.sourceContext ? getTaskSourceCacheScope(args.sourceContext) : null
  const runtimeSettings = getTaskSourceRuntimeSettings(args.sourceContext)
  const environmentId = runtimeSettings.activeRuntimeEnvironmentId
  const runtimeRevision = useAppStore((state) => {
    const runtime = environmentId ? state.runtimeStatusByEnvironmentId?.get(environmentId) : null
    return `${runtime?.connectionGeneration ?? 0}:${runtime?.hostContactEpoch ?? 0}`
  })
  const statusContextKey = getProviderRuntimeContextKey(runtimeSettings)
  const sourceStoreStatus = useAppStore((state) =>
    scope && state.linearStatusContextKey === statusContextKey ? state.linearStatus : null
  )
  const sourceRef = useRef(args.sourceContext)
  useLayoutEffect(() => {
    sourceRef.current = args.sourceContext
  })
  const [state, setState] = useState<{
    scope: string | null
    runtimeRevision: string
    sourceStoreStatus: LinearConnectionStatus | null
    status: LinearConnectionStatus | null
  }>({ scope: null, runtimeRevision, sourceStoreStatus, status: null })

  useEffect(() => {
    const source = sourceRef.current
    if (!args.enabled || !source || !scope) {
      return
    }
    let stale = false
    void linearStatus(source)
      .then((status) => {
        if (!stale) {
          setState({ scope, runtimeRevision, sourceStoreStatus, status })
        }
      })
      .catch(() => {
        if (!stale) {
          setState({
            scope,
            runtimeRevision,
            sourceStoreStatus,
            status: { connected: false, viewer: null }
          })
        }
      })
    return () => {
      stale = true
    }
  }, [args.enabled, scope, runtimeRevision, sourceStoreStatus])

  return useMemo(
    () =>
      scope !== null &&
      state.scope === scope &&
      state.runtimeRevision === runtimeRevision &&
      state.sourceStoreStatus === sourceStoreStatus
        ? { status: state.status, loaded: true }
        : UNLOADED_CONNECTION,
    [scope, state, runtimeRevision, sourceStoreStatus]
  )
}
