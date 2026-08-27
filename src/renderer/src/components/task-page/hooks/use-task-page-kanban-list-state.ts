import { useMemo, useRef, useState } from 'react'
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

  // Why: the stored connection is learned in an effect, so the first frame must
  // not paint the connect empty state — checking is its own state until the
  // seed status object is replaced by the resolved one.
  const initialStatusRef = useRef(kanbanStatus)
  const kanbanStatusChecking = kanbanStatus === initialStatusRef.current

  // Why: the displayed rows keep the last filter whose fetch succeeded, so a
  // pending filter change never hides the previously visible list before the
  // replacement request resolves, and a failed replacement keeps them on screen.
  // The commit follows the React-sanctioned adjust-state-during-render pattern,
  // keyed on a fresh server result replacing the previous one.
  const [kanbanAppliedFilter, setKanbanAppliedFilter] = useState<KanbanTaskFilter>(() =>
    createDefaultKanbanTaskFilter()
  )
  const lastResultRef = useRef<KanbanTaskListResult | null>(null)
  if (kanbanResult !== null && kanbanResult !== lastResultRef.current) {
    lastResultRef.current = kanbanResult
    setKanbanAppliedFilter(kanbanFilter)
  }

  const kanbanViewer = kanbanStatus.connected ? kanbanStatus.viewer : null

  const displayedKanbanTasks = useMemo(() => {
    if (!kanbanResult || !kanbanViewer) {
      return []
    }
    return applyKanbanTaskFilterAndSort({
      tasks: kanbanResult.tasks,
      viewerId: kanbanViewer.id,
      filter: kanbanAppliedFilter
    })
  }, [kanbanAppliedFilter, kanbanResult, kanbanViewer])

  const kanbanListLoadState = deriveKanbanTaskListLoadState({
    status: kanbanStatus,
    statusChecking: kanbanStatusChecking,
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
