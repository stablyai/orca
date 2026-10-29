import { useEffect, useMemo, useState } from 'react'
import type { ClickUpTask } from '../../../../shared/clickup-types'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import { RESULT_LIMIT, type RepoOption } from './smart-workspace-name-field-model'
import { useClickUpSourceConnection } from './use-clickup-source-connection'
import { clickUpListTasks, clickUpSearchTasks } from '@/runtime/runtime-clickup-client'

export function useClickUpSourceSearch({
  enabled,
  mode,
  debouncedQuery,
  sourceQueryWithinLimit,
  selectedRepo
}: {
  enabled: boolean
  mode: SmartNameMode
  debouncedQuery: string
  sourceQueryWithinLimit: boolean
  selectedRepo: RepoOption | null
}) {
  const clickUpSourceContext = useMemo(
    () =>
      selectedRepo
        ? buildTaskSourceContextFromRepo({
            provider: 'clickup',
            projectId: selectedRepo.id,
            repo: selectedRepo
          })
        : null,
    [selectedRepo]
  )
  const connection = useClickUpSourceConnection({
    enabled,
    sourceContext: clickUpSourceContext
  })
  const clickUpAvailable = enabled && connection.loaded && connection.status?.connected === true
  const [clickUpTasks, setClickUpTasks] = useState<ClickUpTask[]>([])
  const [clickUpLoading, setClickUpLoading] = useState(false)

  const shouldQuery =
    clickUpAvailable && sourceQueryWithinLimit && (mode === 'smart' || mode === 'clickup')

  useEffect(() => {
    if (!shouldQuery || !clickUpSourceContext) {
      setClickUpTasks([])
      setClickUpLoading(false)
      return
    }
    let stale = false
    setClickUpLoading(true)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? clickUpSearchTasks(clickUpSourceContext, trimmed, RESULT_LIMIT)
      : clickUpListTasks(clickUpSourceContext, 'assigned', RESULT_LIMIT)
    void request
      .then((tasks) => {
        if (!stale) {
          setClickUpTasks(tasks)
        }
      })
      .catch(() => {
        if (!stale) {
          setClickUpTasks([])
        }
      })
      .finally(() => {
        if (!stale) {
          setClickUpLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [clickUpSourceContext, debouncedQuery, shouldQuery])

  return { clickUpAvailable, clickUpTasks, clickUpLoading, clickUpSourceContext }
}
