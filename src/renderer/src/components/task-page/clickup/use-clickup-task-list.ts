import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { taskProviderErrorText } from '@/lib/work-items/task-provider-error-copy'
import { useAppStore } from '@/store/index'
import { withBusyFlag } from './clickup-busy-flag'
import {
  clickupListCacheKey,
  clickupSearchCacheKey
} from '@/store/slices/clickup/clickup-read-coordination'
import type {
  ClickUpStatusOption,
  ClickUpTask,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'

type ClickUpTaskListArgs = {
  enabled: boolean
  sourceContext: TaskSourceContext | null
  filter: ClickUpTaskListFilter
  /** Applied (trimmed) search text; empty lists the filtered tasks instead. */
  query: string
}

function errorText(error: unknown): string {
  return taskProviderErrorText(error instanceof Error ? error.message : String(error))
}

function mergeStatuses(
  known: ReadonlyMap<string, ClickUpStatusOption>,
  tasks: readonly ClickUpTask[]
): Map<string, ClickUpStatusOption> {
  const next = new Map(known)
  for (const task of tasks) {
    if (!next.has(task.status.name)) {
      next.set(task.status.name, task.status)
    }
  }
  return next
}

/**
 * Loads ClickUp tasks into the store's list cache and reads them back from it, so a status change
 * made anywhere (detail sheet, board) shows in the list without a reload.
 */
export function useClickUpTaskList({ enabled, sourceContext, filter, query }: ClickUpTaskListArgs) {
  const listClickUpTasks = useAppStore((s) => s.listClickUpTasks)
  const searchClickUpTasks = useAppStore((s) => s.searchClickUpTasks)
  const sourceScope = sourceContext ? getTaskSourceCacheScope(sourceContext) : ''
  const listKey = JSON.stringify([sourceScope, filter, query])
  const [loaded, setLoaded] = useState({ key: '', pages: 0 })
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [knownStatuses, setKnownStatuses] = useState<{
    scope: string
    byName: ReadonlyMap<string, ClickUpStatusOption>
  }>({ scope: '', byName: new Map() })
  const forceNextLoadRef = useRef(false)
  // Why: a refresh refetches page zero only, so each later page is forced once to skip cache entries from before it.
  const refreshedPagesRef = useRef<{ key: string; pages: Set<number> } | null>(null)
  const pages = loaded.key === listKey ? loaded.pages : 0

  const entries = useAppStore(
    useShallow((state) => {
      if (!sourceContext) {
        return []
      }
      return query
        ? [state.clickupListCache[clickupSearchCacheKey(state, sourceContext, { query, filter })]]
        : Array.from(
            { length: pages },
            (_, page) =>
              state.clickupListCache[clickupListCacheKey(state, sourceContext, { filter, page })]
          )
    })
  )
  const tasks = useMemo(() => {
    const seen = new Set<string>()
    return entries.flatMap((entry) =>
      (entry?.data?.tasks ?? []).filter((task) => {
        if (seen.has(task.id)) {
          return false
        }
        seen.add(task.id)
        return true
      })
    )
  }, [entries])
  const nextPage = query ? null : (entries.at(-1)?.data?.nextPage ?? null)

  const rememberStatuses = useCallback(
    (loadedTasks: readonly ClickUpTask[]) =>
      setKnownStatuses((current) => ({
        scope: sourceScope,
        byName: mergeStatuses(
          current.scope === sourceScope ? current.byName : new Map(),
          loadedTasks
        )
      })),
    [sourceScope]
  )

  useEffect(() => {
    if (!enabled || !sourceContext) {
      return
    }
    const controller = new AbortController()
    const force = forceNextLoadRef.current
    forceNextLoadRef.current = false
    if (force) {
      refreshedPagesRef.current = { key: listKey, pages: new Set([0]) }
    }
    setLoading(true)
    setFailure(null)
    const request = query
      ? searchClickUpTasks(query, filter, { sourceContext, force, signal: controller.signal })
      : listClickUpTasks({ filter, page: 0 }, { sourceContext, force }).then((page) => page.tasks)
    request
      .then((loadedTasks) => {
        if (!controller.signal.aborted) {
          setLoaded({ key: listKey, pages: 1 })
          rememberStatuses(loadedTasks)
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure({ key: listKey, message: errorText(error) })
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [
    enabled,
    filter,
    listClickUpTasks,
    listKey,
    query,
    refreshNonce,
    rememberStatuses,
    searchClickUpTasks,
    sourceContext
  ])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextPage === null || loadingMore || !sourceContext) {
      return
    }
    const refreshed = refreshedPagesRef.current?.key === listKey ? refreshedPagesRef.current : null
    try {
      const page = await withBusyFlag(setLoadingMore, () =>
        listClickUpTasks(
          { filter, page: nextPage },
          { sourceContext, force: refreshed !== null && !refreshed.pages.has(nextPage) }
        )
      )
      refreshed?.pages.add(nextPage)
      setLoaded((current) =>
        current.key === listKey ? { key: listKey, pages: current.pages + 1 } : current
      )
      rememberStatuses(page.tasks)
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [filter, listClickUpTasks, listKey, loadingMore, nextPage, rememberStatuses, sourceContext])

  const refresh = useCallback(() => {
    forceNextLoadRef.current = true
    setRefreshNonce((nonce) => nonce + 1)
  }, [])

  const error = failure?.key === listKey ? failure.message : null
  return {
    clickupTasks: tasks,
    clickupLoading: enabled && (loading || (pages === 0 && error === null)),
    clickupLoadingMore: loadingMore,
    clickupError: error,
    clickupNextPage: nextPage,
    loadMoreClickUpTasks: loadMore,
    refreshClickUpTasks: refresh,
    clickupKnownStatuses: useMemo(
      () => (knownStatuses.scope === sourceScope ? [...knownStatuses.byName.values()] : []),
      [knownStatuses, sourceScope]
    )
  }
}
