import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import SidebarFilter from './SidebarFilter'
import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'

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
      <SheetHeader className="border-b border-sidebar-border px-4 py-3 pr-32">
        <SheetTitle className="flex items-center gap-2 text-sm">
          <span>Workspace board</span>
          {selectedCount > 1 ? (
            <span className="rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {selectedCount} selected
            </span>
          ) : null}
        </SheetTitle>
        <SheetDescription className="sr-only">
          Organize workspaces by status and open workspace cards.
        </SheetDescription>
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
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
    </>
  )
}
