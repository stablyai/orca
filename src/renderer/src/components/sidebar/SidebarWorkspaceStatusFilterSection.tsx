import React, { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { getEffectiveHiddenWorkspaceStatusIds } from './workspace-status-visibility'
import { translate } from '@/i18n/i18n'

export function getWorkspaceStatusVisibilityLabel(
  statuses: readonly WorkspaceStatusDefinition[],
  hiddenStatusIds: readonly WorkspaceStatus[]
): string {
  const effectiveHiddenIds = getEffectiveHiddenWorkspaceStatusIds(hiddenStatusIds, statuses)
  const visible = statuses.filter((status) => !effectiveHiddenIds.includes(status.id))
  if (visible.length === statuses.length) {
    return translate(
      'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.allStatuses',
      'All statuses'
    )
  }
  if (visible.length === 1) {
    return visible[0]?.label ?? ''
  }
  return translate(
    'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.visibleStatusesCount',
    '{{value0}} statuses',
    { value0: visible.length }
  )
}

/**
 * Next hide-list after clicking `statusId`. Hiding the last visible status is a
 * no-op: it would empty the sidebar with no in-list way back, the same guard
 * the Hosts panel applies to its final host.
 */
export function toggleHiddenWorkspaceStatusId(
  hiddenStatusIds: readonly WorkspaceStatus[],
  statuses: readonly WorkspaceStatusDefinition[],
  statusId: WorkspaceStatus
): readonly WorkspaceStatus[] {
  const hidden = new Set(hiddenStatusIds)
  if (hidden.delete(statusId)) {
    return [...hidden]
  }
  if (statuses.every((status) => status.id === statusId || hidden.has(status.id))) {
    // Why the same array back: a fresh copy would churn store identity into the
    // debounced persisted-UI write for a click that changed nothing.
    return hiddenStatusIds
  }
  hidden.add(statusId)
  return [...hidden]
}

type SidebarWorkspaceStatusFilterSectionProps = {
  preserveWorkspaceBoardOpen?: boolean
}

/**
 * Status visibility for the sidebar workspace list, mirroring the Hosts row:
 * one Sort-by-style row whose nested panel holds the checkboxes.
 */
const SidebarWorkspaceStatusFilterSection = React.memo(
  function SidebarWorkspaceStatusFilterSection({
    preserveWorkspaceBoardOpen = false
  }: SidebarWorkspaceStatusFilterSectionProps) {
    const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
    const hiddenWorkspaceStatusIds = useAppStore((s) => s.hiddenWorkspaceStatusIds)
    const setHiddenWorkspaceStatusIds = useAppStore((s) => s.setHiddenWorkspaceStatusIds)

    const effectiveHiddenIds = getEffectiveHiddenWorkspaceStatusIds(
      hiddenWorkspaceStatusIds,
      workspaceStatuses
    )

    const toggleStatus = useCallback(
      (statusId: WorkspaceStatus) => {
        const next = toggleHiddenWorkspaceStatusId(
          hiddenWorkspaceStatusIds,
          workspaceStatuses,
          statusId
        )
        if (next !== hiddenWorkspaceStatusIds) {
          setHiddenWorkspaceStatusIds([...next])
        }
      },
      [hiddenWorkspaceStatusIds, setHiddenWorkspaceStatusIds, workspaceStatuses]
    )

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
              {getWorkspaceStatusVisibilityLabel(workspaceStatuses, hiddenWorkspaceStatusIds)}
            </span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="w-56"
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          {workspaceStatuses.map((status) => {
            const StatusIcon = getWorkspaceStatusVisualMeta(status).icon
            const visible = !effectiveHiddenIds.includes(status.id)
            return (
              <DropdownMenuCheckboxItem
                key={status.id}
                checked={visible}
                // Why disabled and not just a no-op click: the last visible
                // status cannot be hidden, so say so instead of swallowing it.
                disabled={visible && effectiveHiddenIds.length === workspaceStatuses.length - 1}
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
