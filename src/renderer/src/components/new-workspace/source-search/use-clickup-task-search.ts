import { useEffect, useState } from 'react'
import { taskProviderErrorText } from '@/lib/work-items/task-provider-error-copy'
import { useAppStore } from '@/store'
import { getClickUpReadScope } from '@/store/slices/clickup/clickup-read-coordination'
import type {
  ClickUpTask,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import { RESULT_LIMIT } from '../name-field/smart-workspace-name-field-model'

const SEARCH_FILTER: ClickUpTaskListFilter = { scope: 'all', includeClosed: false }
const ASSIGNED_FILTER: ClickUpTaskListFilter = { scope: 'assigned', includeClosed: false }

export type ClickUpTaskSearchState = {
  tasks: ClickUpTask[]
  loading: boolean
  /** Why the last read failed; null while results are usable. */
  error: string | null
}

const NO_TASKS: ClickUpTask[] = []

type ScopedClickUpTaskSearchState = ClickUpTaskSearchState & {
  /** The source scope that produced `tasks`; rows of another host must never stay selectable. */
  scopeKey: string | null
}

/** Open ClickUp tasks for the composer tab: the viewer's own with no query, a Workspace-wide match otherwise. */
export function useClickUpTaskSearch(args: {
  enabled: boolean
  sourceContext: TaskSourceContext | null
  query: string
}): ClickUpTaskSearchState {
  const { enabled, sourceContext, query } = args
  const listClickUpTasks = useAppStore((state) => state.listClickUpTasks)
  const searchClickUpTasks = useAppStore((state) => state.searchClickUpTasks)
  // A context without its own Workspace reads the status slot's; a slot update after a failed read must re-read.
  const workspaceKey = useAppStore((state) =>
    sourceContext ? getClickUpReadScope(state, sourceContext).workspaceKey : null
  )
  const sourceScope = sourceContext ? getTaskSourceCacheScope(sourceContext) : null
  const scopeKey = sourceScope === null ? null : `${sourceScope}::${workspaceKey}`
  const [state, setState] = useState<ScopedClickUpTaskSearchState>({
    tasks: NO_TASKS,
    loading: false,
    error: null,
    scopeKey: null
  })

  useEffect(() => {
    if (!enabled || !sourceContext) {
      setState({ tasks: NO_TASKS, loading: false, error: null, scopeKey })
      return
    }
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    const trimmed = query.trim()
    const request = trimmed
      ? searchClickUpTasks(trimmed, SEARCH_FILTER, { sourceContext, signal: controller.signal })
      : listClickUpTasks({ filter: ASSIGNED_FILTER, page: 0 }, { sourceContext }).then(
          (page) => page.tasks
        )
    request.then(
      (tasks) => {
        if (!controller.signal.aborted) {
          setState({ tasks: tasks.slice(0, RESULT_LIMIT), loading: false, error: null, scopeKey })
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            tasks: NO_TASKS,
            loading: false,
            error: taskProviderErrorText(error instanceof Error ? error.message : String(error)),
            scopeKey
          })
        }
      }
    )
    return () => controller.abort()
  }, [enabled, listClickUpTasks, query, scopeKey, searchClickUpTasks, sourceContext])

  // Rows read for another source scope stay in state until the new read lands; never expose them.
  if (state.scopeKey !== scopeKey) {
    return { tasks: NO_TASKS, loading: enabled && scopeKey !== null, error: null }
  }
  return state
}
