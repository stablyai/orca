import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getClickUpReadScope } from '@/store/slices/clickup/clickup-read-coordination'
import {
  isClickUpTaskUrl,
  parseClickUpTaskReference,
  type ClickUpTaskReference
} from '../../../../../shared/clickup/clickup-task-reference'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import type { ClickUpSourceConnection } from './use-clickup-source-connection'

const LOOKUP_DEBOUNCE_MS = 200

export type ClickUpUrlSourceError = 'disconnected' | 'update-runtime' | 'read-failed'

export type ClickUpUrlSourceState = {
  intent: boolean
  loading: boolean
  task: ClickUpTask | null
  errorKind: ClickUpUrlSourceError | null
  retry: () => void
}

type ClickUpUrlLookupState = Pick<ClickUpUrlSourceState, 'loading' | 'task' | 'errorKind'> & {
  attemptKey: string | null
}

function isResolvedTaskMatch(reference: ClickUpTaskReference, task: ClickUpTask): boolean {
  return reference.kind === 'id'
    ? task.id === reference.id
    : task.customId?.toUpperCase() === reference.customId
}

/** Resolves a pasted ClickUp task URL to the task it names, through the host that owns the source. */
export function useClickUpUrlSource(args: {
  value: string
  enabled: boolean
  sourceContext: TaskSourceContext | null
  connection: ClickUpSourceConnection
}): ClickUpUrlSourceState {
  const { value, enabled, sourceContext, connection } = args
  const fetchClickUpTask = useAppStore((state) => state.fetchClickUpTask)
  const url = useMemo(
    () => (enabled && isClickUpTaskUrl(value) ? value.trim() : null),
    [enabled, value]
  )
  const reference = useMemo(() => (url ? parseClickUpTaskReference(url) : null), [url])
  const [retryGeneration, setRetryGeneration] = useState(0)
  // A context without its own Workspace reads the status slot's, so a Workspace switch must start a new lookup.
  const slotWorkspaceKey = useAppStore((state) =>
    sourceContext && sourceContext.providerIdentity?.provider !== 'clickup'
      ? getClickUpReadScope(state, sourceContext).workspaceKey
      : null
  )
  const attemptKey =
    url && sourceContext
      ? `${url}::${getTaskSourceCacheScope(sourceContext)}${slotWorkspaceKey === null ? '' : `::${slotWorkspaceKey}`}::${retryGeneration}`
      : null
  const requestGenerationRef = useRef(0)
  const consumedRetryGenerationRef = useRef(0)
  const [state, setState] = useState<ClickUpUrlLookupState>({
    attemptKey: null,
    loading: false,
    task: null,
    errorKind: null
  })

  useEffect(() => {
    const generation = (requestGenerationRef.current += 1)
    if (!url || !reference || !sourceContext || !attemptKey || !connection.loaded) {
      return
    }
    const settle = (result: Pick<ClickUpUrlLookupState, 'task' | 'errorKind'>): void => {
      if (requestGenerationRef.current === generation) {
        setState({ ...result, attemptKey, loading: false })
      }
    }
    if (connection.errorKind || !connection.status?.connected) {
      settle({
        task: null,
        errorKind: connection.errorKind ?? (connection.status ? 'disconnected' : 'read-failed')
      })
      return
    }
    const force = retryGeneration > consumedRetryGenerationRef.current
    const timer = setTimeout(() => {
      consumedRetryGenerationRef.current = retryGeneration
      fetchClickUpTask(url, { sourceContext, force }).then(
        (task) =>
          settle(
            task && isResolvedTaskMatch(reference, task)
              ? { task, errorKind: null }
              : { task: null, errorKind: 'read-failed' }
          ),
        () => settle({ task: null, errorKind: 'read-failed' })
      )
    }, LOOKUP_DEBOUNCE_MS)
    return () => {
      requestGenerationRef.current += 1
      clearTimeout(timer)
    }
  }, [attemptKey, connection, fetchClickUpTask, reference, retryGeneration, sourceContext, url])

  const retry = useCallback((): void => {
    setRetryGeneration((current) => current + 1)
    connection.retry()
  }, [connection])

  const visible =
    state.attemptKey === attemptKey
      ? state
      : { loading: attemptKey !== null, task: null, errorKind: null }
  return {
    intent: url !== null,
    loading: visible.loading,
    task: visible.task,
    errorKind: visible.errorKind,
    retry
  }
}
