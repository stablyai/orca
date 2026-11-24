import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assertLinkedWorkItemContextCapability } from '@/lib/work-items/linked-work-item-capability'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import { clickupApiForTarget } from '@/runtime/clickup/runtime-clickup-client'
import type { ClickUpConnectionStatus } from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'

export type ClickUpSourceConnectionError = 'update-runtime' | 'read-failed'

export type ClickUpSourceConnection = {
  status: ClickUpConnectionStatus | null
  /** True once a read settled for the current source context and retry. */
  loaded: boolean
  errorKind: ClickUpSourceConnectionError | null
  retry: () => void
}

type SettledConnection = Pick<ClickUpSourceConnection, 'status' | 'errorKind'> & { loadKey: string }

const UNLOADED = { status: null, errorKind: null, loaded: false } as const

/** Reads the ClickUp status of the host that owns the composer's source, once the user reaches for it. */
export function useClickUpSourceConnection(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
}): ClickUpSourceConnection {
  const { enabled, sourceContext } = args
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [settled, setSettled] = useState<SettledConnection | null>(null)
  const sourceContextRef = useRef(sourceContext)
  const contextKey = useMemo(
    () => (sourceContext ? getTaskSourceCacheScope(sourceContext) : null),
    [sourceContext]
  )
  const loadKey = contextKey ? `${contextKey}::${retryGeneration}` : null
  // Commit the context before passive reads; discarded renders must not leak ref values.
  useLayoutEffect(() => {
    sourceContextRef.current = sourceContext
  })
  useEffect(() => {
    const source = sourceContextRef.current
    if (!enabled || !source || !loadKey) {
      return
    }
    let stale = false
    const settle = (result: Pick<SettledConnection, 'status' | 'errorKind'>): void => {
      if (!stale) {
        setSettled({ ...result, loadKey })
      }
    }
    const target = taskSourceRuntimeTarget(source)
    const read = async (): Promise<void> => {
      try {
        await assertLinkedWorkItemContextCapability(target, ['clickup'])
      } catch {
        settle({ status: null, errorKind: 'update-runtime' })
        return
      }
      try {
        settle({ status: await clickupApiForTarget(target).status(), errorKind: null })
      } catch {
        settle({ status: null, errorKind: 'read-failed' })
      }
    }
    void read()
    return () => {
      stale = true
    }
  }, [enabled, loadKey])
  const retry = useCallback(() => setRetryGeneration((current) => current + 1), [])
  // Why: consumers use this object as an effect dependency, so it must stay referentially stable.
  return useMemo(
    () =>
      loadKey !== null && settled?.loadKey === loadKey
        ? { status: settled.status, errorKind: settled.errorKind, loaded: true, retry }
        : { ...UNLOADED, retry },
    [loadKey, retry, settled]
  )
}
