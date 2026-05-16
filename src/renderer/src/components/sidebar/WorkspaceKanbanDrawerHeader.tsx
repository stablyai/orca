import React from 'react'
import { LayoutList, Rows3, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SheetClose, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'

type WorkspaceKanbanDrawerHeaderProps = {
  selectedCount: number
  compact: boolean
  opacityPercent: number
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onCompactChange: (compact: boolean) => void
  onOpacityChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  onRenameStatus: (statusId: string, label: string) => void
  onChangeStatusColor: (statusId: string, color: string) => void
  onChangeStatusIcon: (statusId: string, icon: string) => void
  onMoveStatus: (statusId: string, direction: -1 | 1) => void
  onRemoveStatus: (statusId: string) => void
  onAddStatus: () => void
}

export default function WorkspaceKanbanDrawerHeader({
  selectedCount,
  compact,
  opacityPercent,
  workspaceStatuses,
  onCompactChange,
  onOpacityChange,
  onRenameStatus,
  onChangeStatusColor,
  onChangeStatusIcon,
  onMoveStatus,
  onRemoveStatus,
  onAddStatus
}: WorkspaceKanbanDrawerHeaderProps): React.JSX.Element {
  const BoardModeIcon = compact ? Rows3 : LayoutList

  return (
    <>
      <SheetHeader className="border-b border-sidebar-border px-4 py-3 pr-24">
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={compact ? 'secondary' : 'ghost'}
              size="icon-xs"
              aria-pressed={compact}
              aria-label={compact ? 'Compact workspace cards' : 'Detailed workspace cards'}
              onClick={() => onCompactChange(!compact)}
            >
              <BoardModeIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {compact ? 'Show detailed cards' : 'Show compact cards'}
          </TooltipContent>
        </Tooltip>
        <WorkspaceKanbanSettingsMenu
          opacityPercent={opacityPercent}
          workspaceStatuses={workspaceStatuses}
          onOpacityChange={onOpacityChange}
          onRenameStatus={onRenameStatus}
          onChangeStatusColor={onChangeStatusColor}
          onChangeStatusIcon={onChangeStatusIcon}
          onMoveStatus={onMoveStatus}
          onRemoveStatus={onRemoveStatus}
          onAddStatus={onAddStatus}
        />
        <SheetClose asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Close">
            <X className="size-3.5" />
          </Button>
        </SheetClose>
      </div>
    </>
  )
}
