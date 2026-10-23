import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { ClickUpTask } from '../../../../shared/clickup-types'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import { RESULT_LIMIT, type RepoOption } from './smart-workspace-name-field-model'

/** ClickUp search for the composer source picker; account-backed like Linear. */
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
  const { status, statusChecked, checkConnection, listTasks, searchTasks } = useAppStore(
    useShallow((s) => ({
      status: s.clickUpStatus,
      statusChecked: s.clickUpStatusChecked,
      checkConnection: s.checkClickUpConnection,
      listTasks: s.listClickUpTasks,
      searchTasks: s.searchClickUpTasks
    }))
  )
  const [clickUpTasks, setClickUpTasks] = useState<ClickUpTask[]>([])
  const [clickUpLoading, setClickUpLoading] = useState(false)
  const clickUpAvailable = enabled && status.connected === true
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

  useEffect(() => {
    if (enabled && !statusChecked) {
      void checkConnection()
    }
  }, [checkConnection, enabled, statusChecked])

  const shouldQuery =
    clickUpAvailable && sourceQueryWithinLimit && (mode === 'smart' || mode === 'clickup')

  useEffect(() => {
    if (!shouldQuery) {
      setClickUpTasks([])
      setClickUpLoading(false)
      return
    }
    let stale = false
    setClickUpLoading(true)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? searchTasks(trimmed, RESULT_LIMIT, { sourceContext: clickUpSourceContext })
      : listTasks('assigned', RESULT_LIMIT, { sourceContext: clickUpSourceContext })
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
  }, [clickUpSourceContext, debouncedQuery, listTasks, searchTasks, shouldQuery])

  return { clickUpAvailable, clickUpTasks, clickUpLoading, clickUpSourceContext }
}
