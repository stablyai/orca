import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { JiraConnectionStatus } from '../../../../shared/jira/jira-types'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

export type JiraSourceConnection = {
  status: JiraConnectionStatus | null
  /** True once a status read settled for the current source context and connection revision. */
  loaded: boolean
}

type JiraSourceConnectionState = {
  loadKey: string | null
  status: JiraConnectionStatus | null
}

const UNLOADED_CONNECTION: JiraSourceConnection = { status: null, loaded: false }

/** Reuse settled status except on forced retry, failed reads or connected status without sites; those cannot resolve pasted URLs from cache. */
export function canReuseLoadedJiraStatus(
  connection: JiraSourceConnection | null | undefined,
  force: boolean
): connection is JiraSourceConnection & { status: JiraConnectionStatus } {
  const status = connection?.loaded ? connection.status : null
  if (!status || force) {
    return false
  }
  return !status.connected || (status.sites?.length ?? 0) > 0
}

export function getJiraSourceConnectionRevisionKey(
  sourceContext: TaskSourceContext | null
): string | null {
  return sourceContext
    ? getProviderRuntimeContextKey(getTaskSourceRuntimeSettings(sourceContext))
    : null
}

/** Engage only when the user reaches for Jira; retain status afterward and reread only for context/connection revisions. */
export function useJiraSourceConnection(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
}): JiraSourceConnection {
  const readJiraStatus = useAppStore((state) => state.readJiraStatus)
  const contextKey = useMemo(
    () => (args.sourceContext ? getTaskSourceCacheScope(args.sourceContext) : null),
    [args.sourceContext]
  )
  const revisionKey = useMemo(
    () => getJiraSourceConnectionRevisionKey(args.sourceContext),
    [args.sourceContext]
  )
  const connectionRevision = useAppStore((state) =>
    revisionKey ? (state.jiraConnectionRevisions[revisionKey] ?? 0) : 0
  )
  const loadKey = contextKey ? `${contextKey}::${connectionRevision}` : null
  const sourceContextRef = useRef(args.sourceContext)
  // Commit the context before passive reads; discarded/replayed renders must not leak ref values.
  useLayoutEffect(() => {
    sourceContextRef.current = args.sourceContext
  })
  const requestedLoadKeyRef = useRef<string | null>(null)
  const [state, setState] = useState<JiraSourceConnectionState>({
    loadKey: null,
    status: null
  })

  useEffect(() => {
    const sourceContext = sourceContextRef.current
    if (!args.enabled || !sourceContext || !loadKey || requestedLoadKeyRef.current === loadKey) {
      return
    }
    requestedLoadKeyRef.current = loadKey

    void readJiraStatus(sourceContext)
      .then((status) => {
        if (requestedLoadKeyRef.current === loadKey) {
          setState({ loadKey, status })
        }
      })
      .catch(() => {
        if (requestedLoadKeyRef.current === loadKey) {
          setState({ loadKey, status: null })
        }
      })
  }, [args.enabled, loadKey, readJiraStatus])

  // Why: consumers use this object as an effect dependency, so it must stay referentially stable.
  return useMemo(
    () =>
      loadKey !== null && state.loadKey === loadKey
        ? { status: state.status, loaded: true }
        : UNLOADED_CONNECTION,
    [loadKey, state]
  )
}
