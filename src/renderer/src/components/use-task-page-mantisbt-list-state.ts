import type { TaskPageMantisBTConnectStateModel } from './use-task-page-mantisbt-connect-state'
import { useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import type { MantisBTIssue, MantisBTIssueFilter } from '../../../shared/mantisbt-types'
import type { TaskPageMantisBTLoadError } from '@/components/task-page-mantisbt-load-state'
import type { MantisBTIssueSortColumn, MantisBTIssueSortDirection } from './mantisbt-issue-sorter'

export type TaskPageMantisBTListStateModel = TaskPageMantisBTConnectStateModel & {
  mantisBTIssues: MantisBTIssue[]
  setMantisBTIssues: Dispatch<SetStateAction<MantisBTIssue[]>>
  mantisBTLoading: boolean
  setMantisBTLoading: Dispatch<SetStateAction<boolean>>
  mantisBTError: TaskPageMantisBTLoadError | null
  setMantisBTError: Dispatch<SetStateAction<TaskPageMantisBTLoadError | null>>
  mantisBTErrorDetailsOpen: boolean
  setMantisBTErrorDetailsOpen: Dispatch<SetStateAction<boolean>>
  mantisBTSearchInput: string
  setMantisBTSearchInput: Dispatch<SetStateAction<string>>
  activeMantisBTPreset: MantisBTIssueFilter
  setActiveMantisBTPreset: Dispatch<SetStateAction<MantisBTIssueFilter>>
  // Why: composite key, not a bare numeric id — 'all' (no filter) or
  // `${siteId}::${projectId}`, since MantisBT project ids are only unique
  // per-site (see mantisbt-project-queries.ts's projectDedupeKey).
  selectedMantisBTProjectId: string
  setSelectedMantisBTProjectId: Dispatch<SetStateAction<string>>
  mantisBTRefreshNonce: number
  setMantisBTRefreshNonce: Dispatch<SetStateAction<number>>
  mantisBTOrderBy: MantisBTIssueSortColumn
  setMantisBTOrderBy: Dispatch<SetStateAction<MantisBTIssueSortColumn>>
  mantisBTOrderDirection: MantisBTIssueSortDirection
  setMantisBTOrderDirection: Dispatch<SetStateAction<MantisBTIssueSortDirection>>
  handleMantisBTSort: (column: MantisBTIssueSortColumn) => void
}

export function useTaskPageMantisBTListState(
  model: TaskPageMantisBTConnectStateModel
): TaskPageMantisBTListStateModel {
  // MantisBT tab state
  const [mantisBTIssues, setMantisBTIssues] = useState<MantisBTIssue[]>([])
  const [mantisBTLoading, setMantisBTLoading] = useState(false)
  const [mantisBTError, setMantisBTError] = useState<TaskPageMantisBTLoadError | null>(null)
  const [mantisBTErrorDetailsOpen, setMantisBTErrorDetailsOpen] = useState(false)
  const [mantisBTSearchInput, setMantisBTSearchInput] = useState('')
  const [activeMantisBTPreset, setActiveMantisBTPreset] = useState<MantisBTIssueFilter>('assigned')
  const [selectedMantisBTProjectId, setSelectedMantisBTProjectId] = useState('all')
  const [mantisBTRefreshNonce, setMantisBTRefreshNonce] = useState(0)
  const [mantisBTOrderBy, setMantisBTOrderBy] = useState<MantisBTIssueSortColumn>('updated')
  const [mantisBTOrderDirection, setMantisBTOrderDirection] =
    useState<MantisBTIssueSortDirection>('desc')
  const handleMantisBTSort = useCallback(
    (column: MantisBTIssueSortColumn) => {
      if (mantisBTOrderBy === column) {
        setMantisBTOrderDirection((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
      } else {
        setMantisBTOrderBy(column)
        setMantisBTOrderDirection(column === 'title' || column === 'handler' ? 'asc' : 'desc')
      }
    },
    [mantisBTOrderBy]
  )
  return {
    ...model,
    mantisBTIssues,
    setMantisBTIssues,
    mantisBTLoading,
    setMantisBTLoading,
    mantisBTError,
    setMantisBTError,
    mantisBTErrorDetailsOpen,
    setMantisBTErrorDetailsOpen,
    mantisBTSearchInput,
    setMantisBTSearchInput,
    activeMantisBTPreset,
    setActiveMantisBTPreset,
    selectedMantisBTProjectId,
    setSelectedMantisBTProjectId,
    mantisBTRefreshNonce,
    setMantisBTRefreshNonce,
    mantisBTOrderBy,
    setMantisBTOrderBy,
    mantisBTOrderDirection,
    setMantisBTOrderDirection,
    handleMantisBTSort
  }
}
