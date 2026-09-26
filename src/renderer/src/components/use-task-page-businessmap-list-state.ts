import type { TaskPageJiraListStateModel } from './use-task-page-jira-list-state'
import { useState, useCallback } from 'react'
import type { BusinessmapCard, BusinessmapCardFilter } from '../../../shared/businessmap-types'
import type { TaskPageBusinessmapLoadError } from '@/components/task-page-businessmap-load-state'
import type {
  BusinessmapCardSortColumn,
  BusinessmapCardSortDirection
} from '@/components/task-page-businessmap-card-sort'

export function useTaskPageBusinessmapListState(model: TaskPageJiraListStateModel) {
  void model
  const [businessmapCards, setBusinessmapCards] = useState<BusinessmapCard[]>([])
  const [businessmapLoading, setBusinessmapLoading] = useState(false)
  const [businessmapError, setBusinessmapError] = useState<TaskPageBusinessmapLoadError | null>(
    null
  )
  const [businessmapErrorDetailsOpen, setBusinessmapErrorDetailsOpen] = useState(false)
  const [businessmapSearchInput, setBusinessmapSearchInput] = useState('')
  const [appliedBusinessmapSearch, setAppliedBusinessmapSearch] = useState('')
  const [activeBusinessmapPreset, setActiveBusinessmapPreset] =
    useState<BusinessmapCardFilter>('assigned')
  const [businessmapRefreshNonce, setBusinessmapRefreshNonce] = useState(0)
  const [businessmapOrderBy, setBusinessmapOrderBy] = useState<BusinessmapCardSortColumn>('updated')
  const [businessmapOrderDirection, setBusinessmapOrderDirection] =
    useState<BusinessmapCardSortDirection>('desc')
  const handleBusinessmapSort = useCallback(
    (column: BusinessmapCardSortColumn) => {
      if (businessmapOrderBy === column) {
        setBusinessmapOrderDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      } else {
        setBusinessmapOrderBy(column)
        setBusinessmapOrderDirection(column === 'title' ? 'asc' : 'desc')
      }
    },
    [businessmapOrderBy]
  )
  const nextModel = model as typeof model & {
    businessmapCards: typeof businessmapCards
    setBusinessmapCards: typeof setBusinessmapCards
    businessmapLoading: typeof businessmapLoading
    setBusinessmapLoading: typeof setBusinessmapLoading
    businessmapError: typeof businessmapError
    setBusinessmapError: typeof setBusinessmapError
    businessmapErrorDetailsOpen: typeof businessmapErrorDetailsOpen
    setBusinessmapErrorDetailsOpen: typeof setBusinessmapErrorDetailsOpen
    businessmapSearchInput: typeof businessmapSearchInput
    setBusinessmapSearchInput: typeof setBusinessmapSearchInput
    appliedBusinessmapSearch: typeof appliedBusinessmapSearch
    setAppliedBusinessmapSearch: typeof setAppliedBusinessmapSearch
    activeBusinessmapPreset: typeof activeBusinessmapPreset
    setActiveBusinessmapPreset: typeof setActiveBusinessmapPreset
    businessmapRefreshNonce: typeof businessmapRefreshNonce
    setBusinessmapRefreshNonce: typeof setBusinessmapRefreshNonce
    businessmapOrderBy: typeof businessmapOrderBy
    setBusinessmapOrderBy: typeof setBusinessmapOrderBy
    businessmapOrderDirection: typeof businessmapOrderDirection
    setBusinessmapOrderDirection: typeof setBusinessmapOrderDirection
    handleBusinessmapSort: typeof handleBusinessmapSort
  }
  nextModel.businessmapCards = businessmapCards
  nextModel.setBusinessmapCards = setBusinessmapCards
  nextModel.businessmapLoading = businessmapLoading
  nextModel.setBusinessmapLoading = setBusinessmapLoading
  nextModel.businessmapError = businessmapError
  nextModel.setBusinessmapError = setBusinessmapError
  nextModel.businessmapErrorDetailsOpen = businessmapErrorDetailsOpen
  nextModel.setBusinessmapErrorDetailsOpen = setBusinessmapErrorDetailsOpen
  nextModel.businessmapSearchInput = businessmapSearchInput
  nextModel.setBusinessmapSearchInput = setBusinessmapSearchInput
  nextModel.appliedBusinessmapSearch = appliedBusinessmapSearch
  nextModel.setAppliedBusinessmapSearch = setAppliedBusinessmapSearch
  nextModel.activeBusinessmapPreset = activeBusinessmapPreset
  nextModel.setActiveBusinessmapPreset = setActiveBusinessmapPreset
  nextModel.businessmapRefreshNonce = businessmapRefreshNonce
  nextModel.setBusinessmapRefreshNonce = setBusinessmapRefreshNonce
  nextModel.businessmapOrderBy = businessmapOrderBy
  nextModel.setBusinessmapOrderBy = setBusinessmapOrderBy
  nextModel.businessmapOrderDirection = businessmapOrderDirection
  nextModel.setBusinessmapOrderDirection = setBusinessmapOrderDirection
  nextModel.handleBusinessmapSort = handleBusinessmapSort
  return nextModel
}

export type TaskPageBusinessmapListStateModel = ReturnType<typeof useTaskPageBusinessmapListState>
