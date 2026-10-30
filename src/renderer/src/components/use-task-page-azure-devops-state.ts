import type { TaskPageRuntimeHostsModel } from './task-page/use-task-page-runtime-hosts'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import {
  getAzureDevOpsWorkItemWorkspaceSeed,
  getTaskPageRepoSourceContext
} from './task-page/task-page-source-context'
import {
  EMPTY_BACKLOG_FILTERS,
  filterBacklogPage,
  type BacklogFilters
} from './task-page-azure-devops-backlog-filters'
import { excludeInProgressItems } from './task-page-azure-devops-backlog-in-progress'
import { buildBacklogRows } from './task-page-azure-devops-backlog-tree'
import { azureDevOpsColumnWidthKey } from './task-page-azure-devops-backlog-columns'
import type { AzureDevOpsToolbarProps } from '@/components/task-page/azure-devops/Toolbar'
import type { AzureDevOpsBacklogTableProps } from '@/components/task-page/azure-devops/BacklogTable'
import type { AzureDevOpsBoardProps } from '@/components/task-page/azure-devops/Board'
import type { AzureDevOpsWorkItemDialogProps } from '@/components/task-page/azure-devops/WorkItemDialog'
import {
  collectAzureDevOpsViewFilterOptions,
  type TaskPageAzureDevOpsFiltersProps
} from '@/components/task-page/azure-devops/Filters'
import { buildAzureDevOpsContentProps } from './task-page-azure-devops-content-props'
import { resolveAzureDevOpsDetailRelations } from './task-page-azure-devops-detail-relations'
import {
  useAzureDevOpsBacklogLoader,
  type AzureDevOpsTeamSelectionSettings
} from './use-azure-devops-backlog-loader'
import {
  useAzureDevOpsBacklogColumnWidths,
  type AzureDevOpsColumnWidthSettings
} from './use-azure-devops-backlog-column-widths'
import { useAzureDevOpsBoardView } from './use-azure-devops-board-view'
import type { AzureDevOpsBoardErrorStatus } from './use-azure-devops-board-loader'
import type {
  AzureDevOpsTaskView,
  AzureDevOpsViewSelectionSettings
} from './task-page-azure-devops-team-selection-persistence'
import { useAzureDevOpsViewStateSeeding } from './use-azure-devops-view-state-seeding'
import { useAzureDevOpsWorkItemDetail } from './use-azure-devops-work-item-detail'
import {
  azureDevOpsTeamSelectionKey,
  listVisibleAzureDevOpsLevels,
  pickDefaultAzureDevOpsLevel,
  type AzureDevOpsViewsStatus
} from './task-page-azure-devops-backlog-level-selection'

export { azureDevOpsTeamSelectionKey, pickDefaultAzureDevOpsLevel }

export type AzureDevOpsContentProps = {
  status: AzureDevOpsViewsStatus
  errorMessage: string | null
  /** `organization/project` once the configuration is known; feeds the source-context summary. */
  projectLabel: string | null
  view: AzureDevOpsTaskView
  /** Null until the board for the selected level is loaded, or when the backlog is shown. */
  board: AzureDevOpsBoardProps | null
  /** Level items the host could not load, shown as a notice above the table. */
  backlogUnhydratedItemCount: number
  /** How the board load failed, so the page reuses the backlog's host notices. */
  boardErrorStatus: AzureDevOpsBoardErrorStatus | null
  boardErrorMessage: string | null
  toolbar: AzureDevOpsToolbarProps
  filters: TaskPageAzureDevOpsFiltersProps
  table: AzureDevOpsBacklogTableProps
  dialog: AzureDevOpsWorkItemDialogProps
}

export type AzureDevOpsViewSettings = AzureDevOpsTeamSelectionSettings &
  AzureDevOpsColumnWidthSettings &
  AzureDevOpsViewSelectionSettings

const EMPTY_PAGE_PARTS = { items: [], childrenByParent: {}, children: [], parents: [] }

export function useTaskPageAzureDevOpsState(model: TaskPageRuntimeHostsModel) {
  const { taskSource, primaryRepo, settings, updateSettings, openModal } = model
  const active = taskSource === 'azure-devops' && primaryRepo !== null
  const repo = primaryRepo

  const {
    view,
    selectView,
    boardAvailable,
    reportNoBoard,
    status,
    errorMessage,
    teams,
    team,
    teamName,
    selectTeam,
    configuration,
    level,
    columns,
    levelId,
    setLevelId,
    page,
    setPage,
    refresh,
    refreshing
  } = useAzureDevOpsBacklogLoader({
    active,
    repo,
    settings,
    updateSettings
  })

  const [showParents, setShowParents] = useState(false)
  const [showInProgress, setShowInProgress] = useState(true)
  const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set())
  const [filters, setFilters] = useState<BacklogFilters>(EMPTY_BACKLOG_FILTERS)

  useAzureDevOpsViewStateSeeding({
    repo,
    teamName,
    levelId,
    viewSettings: configuration?.viewSettings,
    configurationLoaded: configuration !== null,
    page,
    setShowParents,
    setShowInProgress,
    setFilters
  })

  const widthKey =
    configuration && teamName && levelId
      ? azureDevOpsColumnWidthKey(configuration.repo, teamName, levelId)
      : null
  const columnWidths = useAzureDevOpsBacklogColumnWidths({
    widthKey,
    columns,
    settings,
    updateSettings
  })

  const teamRoute = useMemo(
    () => (teamName ? { teamName, teamId: team?.id ?? null } : null),
    [teamName, team]
  )
  const {
    board,
    boardStatus,
    boardErrorStatus,
    boardErrorMessage,
    refreshBoard,
    collapsedLaneIds,
    toggleLane
  } = useAzureDevOpsBoardView({ active, repo, teamRoute, level, view, reportNoBoard })

  const workItemTypes = useMemo(() => configuration?.workItemTypes ?? {}, [configuration])
  const allItems = useMemo(
    () => [
      ...(page
        ? [...page.items, ...page.children, ...page.parents, ...(page.ancestors ?? [])]
        : []),
      ...(board ? [...board.items, ...board.parents] : [])
    ],
    [page, board]
  )
  const itemById = useMemo(() => new Map(allItems.map((i) => [i.id, i])), [allItems])
  const { detailId, setDetailId, detail, detailLoading, detailError } =
    useAzureDevOpsWorkItemDetail(repo, itemById)
  const filteredPage = useMemo(() => {
    if (!page) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only reached with no page loaded, where no consumer reads the level; the row builder is given an empty item set.
      return { level: level ?? ({} as AzureDevOpsBacklogLevel), ...EMPTY_PAGE_PARTS }
    }
    const visible = showInProgress ? page : excludeInProgressItems(page, workItemTypes)
    return filterBacklogPage(visible, filters)
  }, [page, filters, level, showInProgress, workItemTypes])
  const rows = useMemo(
    () =>
      page
        ? buildBacklogRows(filteredPage, {
            showParents,
            toggled,
            unparentedLabel: translate(
              'auto.components.TaskPage.azureDevOps.unparented',
              'Unparented {{value0}}',
              { value0: page.level.name }
            )
          })
        : [],
    [page, filteredPage, showParents, toggled]
  )

  const useItem = useCallback(
    (id: number) => {
      const item: AzureDevOpsWorkItem | undefined =
        itemById.get(id) ?? (detail?.id === id ? detail : undefined)
      if (!item || !configuration || !teamName) {
        return
      }
      // Why: the linked chip prepends `#number` itself; the title must stay the bare title.
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'azure-devops',
        number: item.id,
        title: item.title,
        url: item.url,
        azureDevOpsIdentifier: String(item.id)
      }
      const taskSourceContext = getTaskPageRepoSourceContext(repo, 'azure-devops', null, {
        provider: 'azure-devops',
        organization: configuration.repo.organization,
        project: configuration.repo.project,
        teamId: team?.id ?? null,
        teamName
      })
      if (!taskSourceContext) {
        toast.error(
          translate(
            'auto.components.TaskPage.azureDevOps.linkUnavailable',
            'Couldn’t link this work item. Reload the backlog and try again.'
          )
        )
        return
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getAzureDevOpsWorkItemWorkspaceSeed(item),
        telemetrySource: 'sidebar'
      })
      setDetailId(null)
    },
    [itemById, detail, configuration, teamName, team, repo, openModal, setDetailId]
  )

  const visibleLevels = useMemo(
    () => listVisibleAzureDevOpsLevels(configuration?.backlog?.levels ?? []),
    [configuration]
  )
  const projectLabel = configuration
    ? [configuration.repo.organization, configuration.repo.project].filter(Boolean).join('/')
    : null
  const filterOptions = collectAzureDevOpsViewFilterOptions({
    view,
    boardItems: board?.items ?? null,
    backlogItems: page ? [...page.items, ...page.children] : [],
    iterations: configuration?.iterations ?? []
  })
  const { parent, childItems } = resolveAzureDevOpsDetailRelations({ detail, itemById })

  const azureDevOpsViews = buildAzureDevOpsContentProps({
    status,
    errorMessage,
    projectLabel,
    teams,
    teamName,
    selectTeam,
    visibleLevels,
    levelId,
    setLevelId,
    setPage,
    setToggled,
    showParents,
    setShowParents,
    showInProgress,
    setShowInProgress,
    columnWidths,
    refresh: view === 'board' ? refreshBoard : refresh,
    refreshing: view === 'board' ? boardStatus === 'loading' : refreshing,
    filters,
    setFilters,
    filterOptions,
    rows,
    itemById,
    workItemTypes,
    view,
    selectView,
    boardAvailable,
    boardPage: board,
    backlogUnhydratedItemCount: page?.unhydratedItemCount ?? 0,
    boardErrorStatus,
    boardErrorMessage,
    collapsedLaneIds,
    onToggleLane: toggleLane,
    detailId,
    setDetailId,
    detail,
    detailLoading,
    detailError,
    parent,
    childItems,
    useItem
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stage pipeline widens the model in place so every later stage sees the fields assigned right below.
  const nextModel = model as typeof model & {
    azureDevOpsViews: typeof azureDevOpsViews
  }
  nextModel.azureDevOpsViews = azureDevOpsViews
  return nextModel
}
export type TaskPageAzureDevOpsStateModel = ReturnType<typeof useTaskPageAzureDevOpsState>
