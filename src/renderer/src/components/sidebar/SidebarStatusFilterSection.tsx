import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { getLiveSelectedWorkspaceStatusIds } from '../../../../shared/workspace-statuses'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'

/**
 * Toggle a status id in the current selection, returning the next selection in
 * catalog order (so persisted filter chips read like the board columns) and
 * dropping ids no longer in the catalog. Pure so it is unit-testable without
 * mounting the Radix submenu.
 */
export function toggleWorkspaceStatusFilter(
  current: readonly WorkspaceStatus[],
  statusId: WorkspaceStatus,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus[] {
  const next = new Set(current)
  if (next.has(statusId)) {
    next.delete(statusId)
  } else {
    next.add(statusId)
  }
  return statuses.filter((status) => next.has(status.id)).map((status) => status.id)
}

function getStatusFilterVisibilityLabel({
  selectedCount,
  selectedLabel
}: {
  selectedCount: number
  selectedLabel: string | null
}): string {
  if (selectedCount === 0) {
    return translate(
      'auto.components.sidebar.SidebarStatusFilterSection.allStatuses',
      'All statuses'
    )
  }
  if (selectedCount === 1 && selectedLabel) {
    return selectedLabel
  }
  return translate(
    'auto.components.sidebar.SidebarStatusFilterSection.selectedStatusesCount',
    '{{value0}} statuses',
    { value0: selectedCount }
  )
}

type SidebarStatusFilterSectionProps = {
  preserveWorkspaceBoardOpen?: boolean
}

/**
 * Filter workspaces by their card status (Todo / In progress / In review /
 * Done, plus any custom statuses). Empty selection shows every status. Renders
 * the same single-row sub-trigger shell as the Projects and Hosts filters.
 *
 * Why shared: mounted in both the sidebar options menu and the workspace board
 * filter menu, which both drive the same `filterWorkspaceStatuses` store state.
 */
const SidebarStatusFilterSection = React.memo(function SidebarStatusFilterSection({
  preserveWorkspaceBoardOpen = false
}: SidebarStatusFilterSectionProps) {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const filterWorkspaceStatuses = useAppStore((s) => s.filterWorkspaceStatuses)
  const setFilterWorkspaceStatuses = useAppStore((s) => s.setFilterWorkspaceStatuses)

  // Why: derive from the live catalog so a since-deleted custom status can't
  // inflate the count or falsely signal an applied filter.
  const selectedStatusIdSet = useMemo(
    () => getLiveSelectedWorkspaceStatusIds(workspaceStatuses, filterWorkspaceStatuses),
    [workspaceStatuses, filterWorkspaceStatuses]
  )
  const selectedCount = selectedStatusIdSet.size
  const hasStatusFilter = selectedCount > 0
  const selectedLabel = useMemo(
    () => workspaceStatuses.find((status) => selectedStatusIdSet.has(status.id))?.label ?? null,
    [workspaceStatuses, selectedStatusIdSet]
  )
  const visibilityLabel = getStatusFilterVisibilityLabel({ selectedCount, selectedLabel })

  const toggleStatus = useCallback(
    (statusId: string) => {
      setFilterWorkspaceStatuses(
        toggleWorkspaceStatusFilter(filterWorkspaceStatuses, statusId, workspaceStatuses)
      )
    },
    [filterWorkspaceStatuses, setFilterWorkspaceStatuses, workspaceStatuses]
  )

  const clearStatuses = useCallback(
    () => setFilterWorkspaceStatuses([]),
    [setFilterWorkspaceStatuses]
  )

  if (workspaceStatuses.length === 0) {
    return null
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {translate('auto.components.sidebar.SidebarStatusFilterSection.status', 'Status')}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {visibilityLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-56"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {translate('auto.components.sidebar.SidebarStatusFilterSection.status', 'Status')}
            {hasStatusFilter && (
              <span className="ml-1.5 font-medium text-foreground">· {selectedCount}</span>
            )}
          </span>
          <button
            type="button"
            onClick={clearStatuses}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!hasStatusFilter}
          >
            {translate('auto.components.sidebar.SidebarStatusFilterSection.clear', 'Clear')}
          </button>
        </div>
        {workspaceStatuses.map((status) => {
          const meta = getWorkspaceStatusVisualMeta(status)
          return (
            <DropdownMenuCheckboxItem
              key={status.id}
              checked={selectedStatusIdSet.has(status.id)}
              // Keep the menu open so several statuses can be toggled at once.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggleStatus(status.id)}
            >
              <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                <meta.icon className={cn('size-3.5 shrink-0', meta.tone)} />
                <span className="truncate">{status.label}</span>
              </span>
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
})

export default SidebarStatusFilterSection
