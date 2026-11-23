import { useEffect, useState } from 'react'
import { taskProviderErrorText } from '@/lib/work-items/task-provider-error-copy'
import { useAppStore } from '@/store'
import type {
  ClickUpTask,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { RESULT_LIMIT } from '../name-field/smart-workspace-name-field-model'

const SEARCH_FILTER: ClickUpTaskListFilter = { scope: 'all', includeClosed: false }
const ASSIGNED_FILTER: ClickUpTaskListFilter = { scope: 'assigned', includeClosed: false }

export type ClickUpTaskSearchState = {
  tasks: ClickUpTask[]
  loading: boolean
  /** Why the last read failed; null while results are usable. */
  error: string | null
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
  const [state, setState] = useState<ClickUpTaskSearchState>({
    tasks: [],
    loading: false,
    error: null
  })

  useEffect(() => {
    if (!enabled || !sourceContext) {
      setState({ tasks: [], loading: false, error: null })
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
          setState({ tasks: tasks.slice(0, RESULT_LIMIT), loading: false, error: null })
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            tasks: [],
            loading: false,
            error: taskProviderErrorText(error instanceof Error ? error.message : String(error))
          })
        }
      }
    )
    return () => controller.abort()
  }, [enabled, listClickUpTasks, query, searchClickUpTasks, sourceContext])

  return state
}
