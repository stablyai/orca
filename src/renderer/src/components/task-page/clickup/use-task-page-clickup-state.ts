import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type {
  ClickUpTask,
  ClickUpTaskListFilter
} from '../../../../../shared/clickup/clickup-types'
import type { TaskPageJiraSummaryGenerationModel } from '../jira/creation/use-task-page-jira-summary-generation'
import { useClickUpTaskList } from './use-clickup-task-list'
import { useTaskPageClickUpWorkspaceAction } from './use-task-page-clickup-workspace-action'

const DEFAULT_CLICKUP_FILTER: ClickUpTaskListFilter = { scope: 'assigned', includeClosed: false }

/** ClickUp's list, search, filter, detail and start-workspace state for the Tasks page. */
export function useTaskPageClickUpState(model: TaskPageJiraSummaryGenerationModel) {
  const {
    taskSource,
    pageData,
    openTaskPage,
    openModal,
    closeTaskDetailPage,
    clickupConnected,
    clickupWorkspaces,
    clickupTaskSourceContext
  } = model
  const selectClickUpWorkspace = useAppStore((s) => s.selectClickUpWorkspace)
  const [clickupFilter, setClickUpFilter] = useState(DEFAULT_CLICKUP_FILTER)
  const [clickupSearchInput, setClickUpSearchInput] = useState('')
  const [appliedClickUpSearch, setAppliedClickUpSearch] = useState('')
  const [clickupConnectOpen, setClickUpConnectOpen] = useState(false)
  const list = useClickUpTaskList({
    enabled: taskSource === 'clickup' && clickupConnected,
    sourceContext: clickupTaskSourceContext,
    filter: clickupFilter,
    query: appliedClickUpSearch
  })
  const { handleUseClickUpItem } = useTaskPageClickUpWorkspaceAction({
    openModal,
    workspaces: clickupWorkspaces,
    sourceContext: clickupTaskSourceContext
  })
  const selectedClickUpTask = pageData.openClickUpTask ?? null
  const clickupDetailSourceContext = pageData.openClickUpSourceContext ?? clickupTaskSourceContext

  const openClickUpDetailPage = useCallback(
    (task: ClickUpTask) =>
      openTaskPage(
        {
          taskSource: 'clickup',
          openClickUpTask: task,
          openClickUpSourceContext: clickupTaskSourceContext
        },
        { recordTasksInteraction: false }
      ),
    [clickupTaskSourceContext, openTaskPage]
  )
  const applyClickUpSearch = useCallback((query: string) => {
    const trimmed = query.trim()
    setClickUpSearchInput(trimmed)
    setAppliedClickUpSearch(trimmed)
  }, [])
  const handleClickUpWorkspaceChange = useCallback(
    (workspaceId: string) => {
      closeTaskDetailPage()
      applyClickUpSearch('')
      setClickUpFilter((current) => ({ ...current, statuses: undefined }))
      void selectClickUpWorkspace(workspaceId).catch(() => {
        toast.error(
          translate(
            'taskProviders.clickup.switchWorkspaceFailed',
            'Failed to switch ClickUp Workspace.'
          )
        )
      })
    },
    [applyClickUpSearch, closeTaskDetailPage, selectClickUpWorkspace]
  )

  return Object.assign(model, {
    ...list,
    clickupFilter,
    setClickUpFilter,
    clickupSearchInput,
    setClickUpSearchInput,
    appliedClickUpSearch,
    applyClickUpSearch,
    clickupConnectOpen,
    setClickUpConnectOpen,
    selectedClickUpTask,
    clickupDetailSourceContext,
    openClickUpDetailPage,
    handleUseClickUpItem,
    handleClickUpWorkspaceChange
  })
}
export type TaskPageClickUpStateModel = ReturnType<typeof useTaskPageClickUpState>
