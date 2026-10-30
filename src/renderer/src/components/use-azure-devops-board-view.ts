import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardPage
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsTeamRoute } from '../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../shared/repo-types'
import {
  useAzureDevOpsBoardLoader,
  type AzureDevOpsBoardErrorStatus,
  type AzureDevOpsBoardLoadStatus
} from './use-azure-devops-board-loader'
import {
  DEFAULT_AZURE_DEVOPS_TASK_VIEW,
  persistAzureDevOpsViewSelection,
  readAzureDevOpsViewSelection,
  type AzureDevOpsTaskView,
  type AzureDevOpsViewSelectionSettings
} from './task-page-azure-devops-team-selection-persistence'

/**
 * The Work items/Backlog/Board choice for the selected level: restored from settings,
 * written back on a pick, and forced to Backlog for a level the session found board-less.
 */
export function useAzureDevOpsBoardViewSelection(args: {
  /** `azureDevOpsViewSelectionKey` for the current (project, team, level); null until known. */
  viewKey: string | null
  settings: AzureDevOpsViewSelectionSettings | null | undefined
  updateSettings: (patch: AzureDevOpsViewSelectionSettings) => Promise<unknown>
}): {
  view: AzureDevOpsTaskView
  selectView: (view: AzureDevOpsTaskView) => void
  boardAvailable: boolean
  reportNoBoard: () => void
} {
  const { viewKey, settings, updateSettings } = args
  // Why: the pick carries its key, and the stored choice is read during render, so the
  // very first render for a level already says Board — no reader loads the backlog first.
  const [picked, setPicked] = useState<{ key: string | null; view: AzureDevOpsTaskView } | null>(
    null
  )
  // Why: a null page is not cached, so without this a board-less level re-requests on every pick.
  const [boardlessKeys, setBoardlessKeys] = useState<ReadonlySet<string>>(() => new Set())
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  const viewKeyRef = useRef(viewKey)
  useEffect(() => {
    viewKeyRef.current = viewKey
  }, [viewKey])

  // Why: the default belongs to "no view yet", not to a level with no stored choice; changing
  // level must not throw the reader out of the view they are in.
  const shownRef = useRef<AzureDevOpsTaskView | null>(null)
  const chosen =
    picked !== null && picked.key === viewKey
      ? picked.view
      : (readAzureDevOpsViewSelection(settings, viewKey) ??
        shownRef.current ??
        DEFAULT_AZURE_DEVOPS_TASK_VIEW)
  // A level this session found board-less, or a Board choice made before the key is known, shows the backlog.
  const view: AzureDevOpsTaskView =
    chosen !== 'board'
      ? chosen
      : viewKey !== null && !boardlessKeys.has(viewKey)
        ? 'board'
        : 'backlog'

  useEffect(() => {
    shownRef.current = view
  }, [view])

  const selectView = useCallback(
    (next: AzureDevOpsTaskView) => {
      const key = viewKeyRef.current
      setPicked({ key, view: next })
      if (key !== null) {
        persistAzureDevOpsViewSelection({
          key,
          view: next,
          settings: settingsRef.current,
          updateSettings
        })
      }
    },
    [updateSettings]
  )

  const reportNoBoard = useCallback(() => {
    const key = viewKeyRef.current
    if (key !== null) {
      setBoardlessKeys((current) => (current.has(key) ? current : new Set(current).add(key)))
    }
    toast.info(
      translate(
        'auto.components.TaskPage.azureDevOps.board.noBoardForLevel',
        'This backlog level has no board, so the backlog is shown instead.'
      )
    )
  }, [])

  return {
    view,
    selectView,
    boardAvailable: viewKey !== null && !boardlessKeys.has(viewKey),
    reportNoBoard
  }
}

/** The board for the selected level while the Board view is shown, and nothing otherwise. */
export function useAzureDevOpsBoardView(args: {
  active: boolean
  repo: Repo | null
  teamRoute: AzureDevOpsTeamRoute | null
  level: AzureDevOpsBacklogLevel | null
  view: AzureDevOpsTaskView
  /** Called once when the host resolves "this level has no board" for the selection. */
  reportNoBoard: () => void
}): {
  board: AzureDevOpsBoardPage | null
  boardStatus: AzureDevOpsBoardLoadStatus
  boardErrorStatus: AzureDevOpsBoardErrorStatus | null
  boardErrorMessage: string | null
  refreshBoard: () => void
  collapsedLaneIds: ReadonlySet<string>
  toggleLane: (laneId: string) => void
} {
  const { reportNoBoard } = args
  const loader = useAzureDevOpsBoardLoader({
    active: args.active,
    repo: args.repo,
    teamRoute: args.teamRoute,
    level: args.level,
    view: args.view
  })
  // A resolved null page is the only "this level has no board" signal the renderer gets.
  const noBoardForLevel =
    args.view === 'board' && loader.status === 'ready' && loader.board === null
  useEffect(() => {
    if (noBoardForLevel) {
      reportNoBoard()
    }
  }, [noBoardForLevel, reportNoBoard])

  return {
    board: loader.board,
    boardStatus: loader.status,
    boardErrorStatus: loader.errorStatus,
    boardErrorMessage: loader.errorMessage,
    refreshBoard: loader.refresh,
    collapsedLaneIds: loader.collapsedLaneIds,
    toggleLane: loader.toggleLane
  }
}
