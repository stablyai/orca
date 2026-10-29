import type { Dispatch, SetStateAction } from 'react'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsTeam,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsFilterOptions } from '@/components/task-page/azure-devops/Filters'
import type { BacklogFilters } from './task-page-azure-devops-backlog-filters'
import type { BacklogRow } from './task-page-azure-devops-backlog-tree'
import type { useAzureDevOpsBacklogColumnWidths } from './use-azure-devops-backlog-column-widths'
import type { AzureDevOpsContentProps } from './use-task-page-azure-devops-state'

// Why: pulled out of the hook so the hook body stays under the file line budget.
export function buildAzureDevOpsContentProps(args: {
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
      view: 'backlog',
      onSelectView: () => undefined,
      boardAvailable: false,
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
