import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import SidebarFilter from './SidebarFilter'
import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanDrawerHeaderProps = {
  selectedCount: number
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onRenameStatus: (statusId: string, label: string) => void
  onChangeStatusColor: (statusId: string, color: string) => void
  onChangeStatusIcon: (statusId: string, icon: string) => void
  onMoveStatus: (statusId: string, direction: -1 | 1) => void
  onRemoveStatus: (statusId: string) => void
  onAddStatus: () => void
  onFilterMenuOpenChange: (open: boolean) => void
  onClose: () => void
}

export default function WorkspaceKanbanDrawerHeader({
  selectedCount,
  workspaceStatuses,
  onRenameStatus,
  onChangeStatusColor,
  onChangeStatusIcon,
  onMoveStatus,
  onRemoveStatus,
  onAddStatus,
  onFilterMenuOpenChange,
  onClose
}: WorkspaceKanbanDrawerHeaderProps): React.JSX.Element {
  return (
    <>
      <SheetHeader className="border-b border-worktree-sidebar-border px-4 py-3 pr-32">
        <SheetTitle className="flex items-center gap-2 text-sm">
          <span>{translate("auto.components.sidebar.WorkspaceKanbanDrawerHeader.c6a77ab0f4", "Workspace board")}</span>
          {selectedCount > 1 ? (
            <span className="rounded-full bg-worktree-sidebar-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {selectedCount} {translate("auto.components.sidebar.WorkspaceKanbanDrawerHeader.81870af08f", "selected")}</span>
          ) : null}
        </SheetTitle>
        <SheetDescription className="sr-only">
          {translate("auto.components.sidebar.WorkspaceKanbanDrawerHeader.e1a34450fc", "Organize workspaces by status and open workspace cards.")}</SheetDescription>
      </SheetHeader>

      <div className="absolute right-3 top-2.5 flex items-center gap-1">
        <SidebarFilter
          preserveWorkspaceBoardOpen
          tooltipSide="top"
          contentSide="bottom"
          onMenuOpenChange={onFilterMenuOpenChange}
        />
        <WorkspaceKanbanSettingsMenu
          workspaceStatuses={workspaceStatuses}
          onRenameStatus={onRenameStatus}
          onChangeStatusColor={onChangeStatusColor}
          onChangeStatusIcon={onChangeStatusIcon}
          onMoveStatus={onMoveStatus}
          onRemoveStatus={onRemoveStatus}
          onAddStatus={onAddStatus}
        />
        <Button variant="ghost" size="icon-xs" aria-label={translate("auto.components.sidebar.WorkspaceKanbanDrawerHeader.f369f5c5a3", "Close")} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
    </>
  )
}
