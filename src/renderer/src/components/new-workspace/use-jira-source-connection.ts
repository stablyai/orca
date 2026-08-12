import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { JiraConnectionStatus } from '../../../../shared/types'
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

/**
 * Reuse an already-loaded status instead of re-reading it for every URL resolve.
 *
 * A forced retry, a failed read, or a connected status with no sites still needs a fresh read —
 * those are exactly the cases where the cached answer cannot resolve the pasted URL.
 */
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

/**
 * Read Jira connection status for a source context, lazily.
 *
 * `enabled` is an engagement signal, not a mount signal: callers pass `true` only once the user
 * actually reaches for Jira, so opening the composer costs no IPC/RPC round-trip. Status stays
 * readable after engagement drops, and re-reads only when the context or connection revision moves.
 */
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
  // Layout effects run before the read effect below, so the ref is current without
  // being mutated during a render React may replay or discard.
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
