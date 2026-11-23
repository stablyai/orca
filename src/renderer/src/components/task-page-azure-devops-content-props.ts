import type { Dispatch, SetStateAction } from 'react'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsBoardPage,
  AzureDevOpsTeam,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsFilterOptions } from '@/components/task-page/azure-devops/Filters'
import type { AzureDevOpsBoardProps } from '@/components/task-page/azure-devops/Board'
import { buildAzureDevOpsBoardLayout } from './task-page-azure-devops-board-layout'
import type { AzureDevOpsTaskView } from './task-page-azure-devops-team-selection-persistence'
import {
  matchesBacklogFilters,
  type BacklogFilters
} from './task-page-azure-devops-backlog-filters'
import type { BacklogRow } from './task-page-azure-devops-backlog-tree'
import {
  azureDevOpsWorkItemColumns,
  buildAzureDevOpsWorkItemRows
} from './task-page-azure-devops-work-item-rows'
import type { useAzureDevOpsBacklogColumnWidths } from './use-azure-devops-backlog-column-widths'
import type { AzureDevOpsContentProps } from './use-task-page-azure-devops-state'

function buildBoardProps(args: {
  page: AzureDevOpsBoardPage
  filters: BacklogFilters
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  collapsedLaneIds: ReadonlySet<string>
  onToggleLane: (laneId: string) => void
  onOpenItem: (id: number) => void
  onUseItem: (item: AzureDevOpsWorkItem) => void
}): AzureDevOpsBoardProps {
  // The board filters locally, like the backlog, so the WIP counters match what is on screen.
  const items = args.page.items.filter((item) => matchesBacklogFilters(item, args.filters))
  // `page.parents` omits parents that are on the board themselves; cards need both sources.
  const parentsById: Record<number, AzureDevOpsWorkItem> = {}
  for (const candidate of [...args.page.items, ...args.page.parents]) {
    parentsById[candidate.id] = candidate
  }
  const workItemTypes = Object.values(args.workItemTypes)
  return {
    layout: buildAzureDevOpsBoardLayout({
      configuration: args.page.configuration,
      items,
      workItemTypes
    }),
    configuration: args.page.configuration,
    workItemTypes,
    parentsById,
    unhydratedItemCount: args.page.unhydratedItemCount ?? 0,
    unhydratedParentCount: args.page.unhydratedParentCount ?? 0,
    collapsedLaneIds: args.collapsedLaneIds,
    onToggleLane: args.onToggleLane,
    onOpenItem: args.onOpenItem,
    onUseItem: args.onUseItem
  }
}

// Why: pulled out of the hook so the hook body stays under the file line budget.
export function buildAzureDevOpsContentProps(args: {
  /** Items assigned to the signed-in user project-wide, most recently changed first. */
  workItems: AzureDevOpsWorkItem[]
  workItemsUnhydratedItemCount: number
  workItemsTruncatedAtQueryLimit: number | null
  workItemsErrorStatus: AzureDevOpsContentProps['workItems']['errorStatus']
  workItemsErrorMessage: string | null
  workItemsLoading: boolean
  status: AzureDevOpsContentProps['status']
  errorMessage: string | null
  projectLabel: string | null
  teams: AzureDevOpsTeam[]
  teamName: string | null
  selectTeam: (teamName: string) => void
  visibleLevels: AzureDevOpsBacklogLevel[]
  levelId: string | null
  setLevelId: (id: string) => void
  setPage: (page: AzureDevOpsBacklogPage | null) => void
  setToggled: Dispatch<SetStateAction<ReadonlySet<number>>>
  showParents: boolean
  setShowParents: (next: boolean) => void
  showInProgress: boolean
  setShowInProgress: (next: boolean) => void
  columnWidths: ReturnType<typeof useAzureDevOpsBacklogColumnWidths>
  refresh: () => void
  refreshing: boolean
  filters: BacklogFilters
  setFilters: Dispatch<SetStateAction<BacklogFilters>>
  filterOptions: AzureDevOpsFilterOptions
  rows: BacklogRow[]
  itemById: ReadonlyMap<number, AzureDevOpsWorkItem>
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  view: AzureDevOpsTaskView
  selectView: (view: AzureDevOpsTaskView) => void
  boardAvailable: boolean
  boardPage: AzureDevOpsBoardPage | null
  /** Level items the host could not load, shown as a notice above the table. */
  backlogUnhydratedItemCount: number
  boardErrorStatus: AzureDevOpsContentProps['boardErrorStatus']
  boardErrorMessage: string | null
  collapsedLaneIds: ReadonlySet<string>
  onToggleLane: (laneId: string) => void
  detailId: number | null
  setDetailId: Dispatch<SetStateAction<number | null>>
  detail: AzureDevOpsWorkItemDetail | null
  detailLoading: boolean
  detailError: string | null
  parent: AzureDevOpsWorkItem | null
  childItems: AzureDevOpsWorkItem[]
  useItem: (id: number) => void
}): AzureDevOpsContentProps {
  return {
    status: args.status,
    errorMessage: args.errorMessage,
    projectLabel: args.projectLabel,
    view: args.view,
    boardErrorStatus: args.boardErrorStatus,
    boardErrorMessage: args.boardErrorMessage,
    board:
      args.view === 'board' && args.boardPage
        ? buildBoardProps({
            page: args.boardPage,
            filters: args.filters,
            workItemTypes: args.workItemTypes,
            collapsedLaneIds: args.collapsedLaneIds,
            onToggleLane: args.onToggleLane,
            onOpenItem: args.setDetailId,
            onUseItem: (item) => args.useItem(item.id)
          })
        : null,
    toolbar: {
      teams: args.teams,
      selectedTeamName: args.teamName,
      onSelectTeam: args.selectTeam,
      levels: args.visibleLevels,
      selectedLevelId: args.levelId,
      onSelectLevel: (id) => {
        args.setLevelId(id)
        args.setPage(null)
        args.setToggled(new Set())
      },
      view: args.view,
      onSelectView: args.selectView,
      boardAvailable: args.boardAvailable,
      showParents: args.showParents,
      onToggleShowParents: args.setShowParents,
      showInProgress: args.showInProgress,
      onToggleShowInProgress: args.setShowInProgress,
      onResetColumnWidths: args.columnWidths.hasOverrides
        ? args.columnWidths.resetColumnWidths
        : null,
      onRefresh: args.refresh,
      refreshing: args.refreshing
    },
    filters: {
      filters: args.filters,
      options: args.filterOptions,
      onChange: args.setFilters
    },
    backlogUnhydratedItemCount: args.backlogUnhydratedItemCount,
    workItems: {
      // The view filters locally, like the backlog and the board.
      table: {
        rows: buildAzureDevOpsWorkItemRows(
          args.workItems.filter((item) => matchesBacklogFilters(item, args.filters))
        ),
        columnFields: azureDevOpsWorkItemColumns(),
        workItemTypes: args.workItemTypes,
        tagColors: {},
        itemById: args.itemById,
        // Flat list: nothing expands, so the handler has no row to act on.
        onToggleExpand: () => {},
        onOpenItem: args.setDetailId,
        onUseItem: args.useItem
      },
      totalItemCount: args.workItems.length,
      unhydratedItemCount: args.workItemsUnhydratedItemCount,
      truncatedAtQueryLimit: args.workItemsTruncatedAtQueryLimit,
      errorStatus: args.workItemsErrorStatus,
      errorMessage: args.workItemsErrorMessage,
      loading: args.workItemsLoading
    },
    table: {
      rows: args.rows,
      columnFields: args.columnWidths.columns,
      workItemTypes: args.workItemTypes,
      tagColors: {},
      itemById: args.itemById,
      onResizeColumn: args.columnWidths.onResizeColumn,
      onResizeEnd: args.columnWidths.onResizeEnd,
      onToggleExpand: (id) =>
        args.setToggled((current) => {
          const next = new Set(current)
          if (next.has(id)) {
            next.delete(id)
          } else {
            next.add(id)
          }
          return next
        }),
      onOpenItem: args.setDetailId,
      onUseItem: args.useItem
    },
    dialog: {
      open: args.detailId !== null,
      onOpenChange: (open) => {
        if (!open) {
          args.setDetailId(null)
        }
      },
      detail: args.detail,
      loading: args.detailLoading,
      error: args.detailError,
      workItemTypes: args.workItemTypes,
      tagColors: {},
      parent: args.parent,
      childItems: args.childItems,
      onOpenItem: args.setDetailId,
      onUseItem: args.useItem
    }
  }
}
