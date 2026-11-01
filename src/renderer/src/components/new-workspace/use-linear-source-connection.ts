import type {
  LinearIssueData,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { linearStatus } from '@/runtime/runtime-linear-client'
import { useAppStore } from '@/store'
import { getLinearStatusReadGeneration } from '@/store/slices/linear/linear-slice-request-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import {
  linearReadAccountRejections,
  withoutLinearAccountWorkspaces
} from '@/store/slices/linear/linear-cache'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'

type LinearSourceConnection = {
  status: LinearConnectionStatus | null
  loaded: boolean
  refresh: (observation?: {
    view: LinearIssueView<LinearIssueData>
    workspaceId?: string | null
    status: LinearConnectionStatus
  }) => Promise<void>
}

const UNLOADED_CONNECTION = { status: null, loaded: false }

export function useLinearSourceConnection(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
}): LinearSourceConnection {
  const runtimeSettings = getTaskSourceRuntimeSettings(args.sourceContext)
  const environmentId = runtimeSettings.activeRuntimeEnvironmentId
  const runtimeRevision = useAppStore((state) => {
    const runtime = environmentId ? state.runtimeStatusByEnvironmentId?.get(environmentId) : null
    return `${runtime?.connectionGeneration ?? 0}:${runtime?.hostContactEpoch ?? 0}`
  })
  const statusContextKey = getProviderRuntimeContextKey(runtimeSettings)
  // Why: Linear status is per host, so switching repos on one host keeps the loaded status.
  const scope = args.sourceContext ? statusContextKey : null
  const sourceRef = useRef(args.sourceContext)
  useLayoutEffect(() => {
    sourceRef.current = args.sourceContext
  })
  const [state, setState] = useState<{
    scope: string | null
    status: LinearConnectionStatus | null
  }>({ scope: null, status: null })

  const current = useRef<{
    refresh: LinearSourceConnection['refresh']
  } | null>(null)
  const refresh = useCallback(
    (observation?: Parameters<LinearSourceConnection['refresh']>[0]) =>
      current.current?.refresh(observation) ?? Promise.resolve(),
    []
  )
  useLayoutEffect(() => {
    const source = sourceRef.current
    if (!args.enabled || !source || !scope) {
      return
    }
    const runtime = getLinearSourceScope(source)
    let request: object | null = null
    const lifetime = {
      refresh: async (observation?: Parameters<LinearSourceConnection['refresh']>[0]) => {
        if (current.current !== lifetime || !runtime.isCurrentRuntime()) {
          return
        }
        if (observation && observation.view.kind !== 'data' && observation.view.kind !== 'error') {
          return
        }
        const rejectedWorkspaces = observation
          ? linearReadAccountRejections(
              observation.view.data,
              observation.view.kind === 'error' ? observation.view.error : undefined,
              observation.workspaceId,
              observation.status,
              source
            )
          : []
        if (rejectedWorkspaces === null) {
          return
        }
        if (rejectedWorkspaces.length) {
          setState((previous) =>
            previous.scope === scope && previous.status
              ? {
                  ...previous,
                  status: withoutLinearAccountWorkspaces(previous.status, rejectedWorkspaces)
                }
              : previous
          )
        }
        const token = {}
        request = token
        const isCurrent = () =>
          current.current === lifetime && request === token && runtime.isCurrentRuntime()
        try {
          const status = await linearStatus(source)
          if (isCurrent()) {
            setState({ scope, status })
          }
        } catch {
          if (isCurrent()) {
            setState((previous) => (previous.scope === scope ? previous : { scope, status: null }))
          }
        }
      }
    }
    current.current = lifetime
    let observed = getLinearStatusReadGeneration()
    const adopt = (snapshot: ReturnType<typeof useAppStore.getState>) => {
      if (
        current.current !== lifetime ||
        !runtime.isCurrentRuntime() ||
        !snapshot.linearStatusObserved ||
        snapshot.linearStatusContextKey !== scope
      ) {
        return false
      }
      request = null
      setState({ scope, status: snapshot.linearStatus })
      return true
    }
    const unsubscribe = useAppStore.subscribe((snapshot, previous) => {
      const generation = getLinearStatusReadGeneration()
      const changed =
        generation !== observed ||
        snapshot.linearStatus !== previous.linearStatus ||
        snapshot.linearStatusContextKey !== previous.linearStatusContextKey ||
        snapshot.linearStatusObserved !== previous.linearStatusObserved
      observed = generation
      if (changed) {
        adopt(snapshot)
      }
    })
    if (!adopt(useAppStore.getState())) {
      void lifetime.refresh()
    }
    return () => {
      unsubscribe()
      if (current.current === lifetime) {
        current.current = null
      }
    }
  }, [args.enabled, scope, runtimeRevision])

  // Why: a same-host re-read keeps the last status so the Linear tab and selected mode don't flicker.
  return useMemo(
    () => ({
      ...(scope !== null && state.scope === scope
        ? { status: state.status, loaded: true }
        : UNLOADED_CONNECTION),
      refresh
    }),
    [scope, state, refresh]
  )
}
