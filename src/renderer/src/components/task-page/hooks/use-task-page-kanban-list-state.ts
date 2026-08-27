import { useMemo, useState } from 'react'
import type {
  KanbanConnectionStatus,
  KanbanTaskDetails,
  KanbanTaskFilter,
  KanbanTaskListResult
} from '../../../../../shared/kanban-types'
import {
  applyKanbanTaskFilterAndSort,
  createDefaultKanbanTaskFilter
} from '@/components/task-page-kanban-filtering'
import {
  deriveKanbanTaskDetailState,
  deriveKanbanTaskListLoadState,
  type KanbanListLoadError
} from './use-task-page-kanban-fetch'

export function useTaskPageKanbanListState() {
  const [kanbanStatus, setKanbanStatus] = useState<KanbanConnectionStatus>({
    connected: false,
    reason: 'missing'
  })
  // Why: the default executor filter is seeded up front so the first fetch
  // never paints all accessible tasks before the user changes a filter.
  const [kanbanFilter, setKanbanFilter] = useState<KanbanTaskFilter>(() =>
    createDefaultKanbanTaskFilter()
  )
  const [kanbanResult, setKanbanResult] = useState<KanbanTaskListResult | null>(null)
  const [kanbanLoading, setKanbanLoading] = useState(false)
  const [kanbanLoadError, setKanbanLoadError] = useState<KanbanListLoadError | null>(null)
  const [kanbanRefreshNonce, setKanbanRefreshNonce] = useState(0)
  const [kanbanSelectedTaskId, setKanbanSelectedTaskId] = useState<string | null>(null)
  const [kanbanDetail, setKanbanDetail] = useState<KanbanTaskDetails | null>(null)
  const [kanbanDetailLoading, setKanbanDetailLoading] = useState(false)
  const [kanbanDetailError, setKanbanDetailError] = useState(false)
  const [kanbanConnectOpen, setKanbanConnectOpen] = useState(false)

  const kanbanViewer = kanbanStatus.connected ? kanbanStatus.viewer : null

  const displayedKanbanTasks = useMemo(() => {
    if (!kanbanResult || !kanbanViewer) {
      return []
    }
    return applyKanbanTaskFilterAndSort({
      tasks: kanbanResult.tasks,
      viewerId: kanbanViewer.id,
      filter: kanbanFilter
    })
  }, [kanbanFilter, kanbanResult, kanbanViewer])

  const kanbanListLoadState = deriveKanbanTaskListLoadState({
    status: kanbanStatus,
    loading: kanbanLoading,
    error: kanbanLoadError,
    visibleTaskCount: displayedKanbanTasks.length
  })

  const kanbanDetailState = deriveKanbanTaskDetailState({
    selectedTaskId: kanbanSelectedTaskId,
    detail: kanbanDetail,
    detailLoading: kanbanDetailLoading,
    detailError: kanbanDetailError
  })

  return {
    kanbanStatus,
    setKanbanStatus,
    kanbanViewer,
    kanbanFilter,
    setKanbanFilter,
    kanbanResult,
    setKanbanResult,
    kanbanLoading,
    setKanbanLoading,
    kanbanLoadError,
    setKanbanLoadError,
    kanbanRefreshNonce,
    setKanbanRefreshNonce,
    kanbanSelectedTaskId,
    setKanbanSelectedTaskId,
    kanbanDetail,
    setKanbanDetail,
    kanbanDetailLoading,
    setKanbanDetailLoading,
    kanbanDetailError,
    setKanbanDetailError,
    kanbanConnectOpen,
    setKanbanConnectOpen,
    displayedKanbanTasks,
    kanbanListLoadState,
    kanbanDetailState
  }
}
