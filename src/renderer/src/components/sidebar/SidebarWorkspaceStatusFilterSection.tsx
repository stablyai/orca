import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { translate } from '@/i18n/i18n'

/**
 * Next selection after clicking `statusId`, in catalog order.
 *
 * Selecting every status collapses back to the empty "all" selection so the
 * filter badge and Clear Filters agree with what the list actually shows.
 * Deselecting the last remaining status does the same rather than emptying the
 * sidebar with no visible cause.
 */
export function toggleFilterWorkspaceStatus(
  selected: readonly WorkspaceStatus[],
  statuses: readonly WorkspaceStatusDefinition[],
  statusId: WorkspaceStatus
): readonly WorkspaceStatus[] {
  const next = new Set(selected.filter((id) => statuses.some((status) => status.id === id)))
  if (!next.delete(statusId)) {
    next.add(statusId)
  }
  if (next.size === 0 || next.size === statuses.length) {
    // Why the same array back when already empty: a fresh [] would churn store
    // identity into the debounced persisted-UI write for a no-op click.
    return selected.length === 0 ? selected : []
  }
  return statuses.filter((status) => next.has(status.id)).map((status) => status.id)
}

export function getWorkspaceStatusFilterLabel(
  statuses: readonly WorkspaceStatusDefinition[],
  selected: readonly WorkspaceStatus[]
): string {
  const selectedDefinitions = statuses.filter((status) => selected.includes(status.id))
  if (selectedDefinitions.length === 0 || selectedDefinitions.length === statuses.length) {
    return translate(
      'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.allStatuses',
      'All statuses'
    )
  }
  if (selectedDefinitions.length === 1) {
    return selectedDefinitions[0]?.label ?? ''
  }
  return translate(
    'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.selectedStatusesCount',
    '{{value0}} statuses',
    { value0: selectedDefinitions.length }
  )
}

type SidebarWorkspaceStatusFilterSectionProps = {
  preserveWorkspaceBoardOpen?: boolean
}

/**
 * Card-status visibility for the sidebar workspace list, mirroring the Hosts
 * row: one Sort-by-style row whose nested panel holds the checkboxes.
 */
const SidebarWorkspaceStatusFilterSection = React.memo(
  function SidebarWorkspaceStatusFilterSection({
    preserveWorkspaceBoardOpen = false
  }: SidebarWorkspaceStatusFilterSectionProps) {
    const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
    const filterWorkspaceStatuses = useAppStore((s) => s.filterWorkspaceStatuses)
    const setFilterWorkspaceStatuses = useAppStore((s) => s.setFilterWorkspaceStatuses)

    // Why derive from the catalog: a stale id left by a deleted status must not
    // check a row or inflate the count while the pipeline ignores it.
    const selectedStatusIds = useMemo(() => {
      const set = new Set<WorkspaceStatus>()
      for (const status of workspaceStatuses) {
        if (filterWorkspaceStatuses.includes(status.id)) {
          set.add(status.id)
        }
      }
      return set
    }, [workspaceStatuses, filterWorkspaceStatuses])
    const allVisible =
      selectedStatusIds.size === 0 || selectedStatusIds.size === workspaceStatuses.length

    const toggleStatus = useCallback(
      (statusId: WorkspaceStatus) => {
        const next = toggleFilterWorkspaceStatus(
          filterWorkspaceStatuses,
          workspaceStatuses,
          statusId
        )
        if (next !== filterWorkspaceStatuses) {
          setFilterWorkspaceStatuses(next)
        }
      },
      [filterWorkspaceStatuses, setFilterWorkspaceStatuses, workspaceStatuses]
    )

    const showAllStatuses = useCallback(() => {
      if (filterWorkspaceStatuses.length > 0) {
        setFilterWorkspaceStatuses([])
      }
    }, [filterWorkspaceStatuses, setFilterWorkspaceStatuses])

    if (workspaceStatuses.length < 2) {
      return null
    }

    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex flex-1 items-center justify-between gap-3">
            <span>
              {translate(
                'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.status',
                'Status'
              )}
            </span>
            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
              {getWorkspaceStatusFilterLabel(workspaceStatuses, filterWorkspaceStatuses)}
            </span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="w-56"
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          <DropdownMenuCheckboxItem
            checked={allVisible}
            // Why not disabled when already checked: unchecking "All" has no
            // sensible target status, so swallow it rather than offer a control
            // that empties the list.
            onCheckedChange={showAllStatuses}
            onSelect={(e) => e.preventDefault()}
          >
            {translate(
              'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.allStatuses',
              'All statuses'
            )}
          </DropdownMenuCheckboxItem>
          {workspaceStatuses.map((status) => {
            const StatusIcon = getWorkspaceStatusVisualMeta(status).icon
            return (
              <DropdownMenuCheckboxItem
                key={status.id}
                checked={selectedStatusIds.has(status.id)}
                onCheckedChange={() => toggleStatus(status.id)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <StatusIcon className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{status.label}</span>
                </span>
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }
)

export default SidebarWorkspaceStatusFilterSection
