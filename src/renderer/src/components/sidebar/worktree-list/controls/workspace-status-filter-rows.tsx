import type React from 'react'
import { Kanban } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { getWorkspaceStatusVisualMeta } from '../../workspace-status/presentation/workspace-status'
import { translateWorkspaceBoardStatusLabel } from '../../workspace-status/presentation/workspace-board-status-label'
import { useWorkspaceBoardStatuses } from '../../workspace-status/presentation/use-workspace-board-statuses'
import { FilterToggleRow } from './FilterToggleRow'

/** "Hide by status", then one switch per board status while it is on. */
export function WorkspaceStatusFilterRows(): React.JSX.Element {
  const t = useTranslate()
  const hideByStatus = useAppStore((s) => s.hideWorkspacesByStatus)
  const setHideByStatus = useAppStore((s) => s.setHideWorkspacesByStatus)
  const hiddenStatusIds = useAppStore((s) => s.hiddenWorkspaceStatusIds)
  const setHiddenStatusIds = useAppStore((s) => s.setHiddenWorkspaceStatusIds)
  const statuses = useWorkspaceBoardStatuses()
  return (
    <>
      <FilterToggleRow
        icon={<Kanban className="size-3.5" />}
        label={t(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.hideByStatus',
          'Hide by status'
        )}
        checked={hideByStatus}
        onChange={setHideByStatus}
      />
      {hideByStatus &&
        statuses.map((status) => {
          const meta = getWorkspaceStatusVisualMeta(status, t)
          const label = translateWorkspaceBoardStatusLabel(status)
          return (
            <FilterToggleRow
              key={status.id}
              indented
              icon={<meta.icon className={cn('size-3.5', meta.tone)} />}
              label={label}
              ariaLabel={t(
                'auto.components.sidebar.SidebarWorkspaceFilterSection.hideStatusAria',
                'Hide {{status}} workspaces',
                { status: label }
              )}
              checked={hiddenStatusIds.includes(status.id)}
              onChange={(hide) =>
                setHiddenStatusIds(
                  hide
                    ? [...hiddenStatusIds, status.id]
                    : hiddenStatusIds.filter((id) => id !== status.id)
                )
              }
            />
          )
        })}
    </>
  )
}
