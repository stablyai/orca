import React from 'react'
import { ArrowDown, ArrowUp, Plus, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import WorkspaceStatusAppearancePopover from './WorkspaceStatusAppearancePopover'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanSettingsMenuProps = {
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onRenameStatus: (statusId: string, label: string) => void
  onChangeStatusColor: (statusId: string, color: string) => void
  onChangeStatusIcon: (statusId: string, icon: string) => void
  onMoveStatus: (statusId: string, direction: -1 | 1) => void
  onRemoveStatus: (statusId: string) => void
  onAddStatus: () => void
}

export default function WorkspaceKanbanSettingsMenu({
  workspaceStatuses,
  onRenameStatus,
  onChangeStatusColor,
  onChangeStatusIcon,
  onMoveStatus,
  onRemoveStatus,
  onAddStatus
}: WorkspaceKanbanSettingsMenuProps): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.26cbc92150", "Workspace board settings")}
              data-contextual-tour-target="workspace-board-settings"
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.34f03eb0de", "Board settings")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="max-h-[min(80vh,720px)] w-80 overflow-y-auto p-2 scrollbar-sleek"
        onInteractOutside={(event) => {
          const target = event.target
          if (
            target instanceof Element &&
            target.closest('[data-workspace-status-appearance-popover]')
          ) {
            event.preventDefault()
          }
        }}
      >
        <DropdownMenuLabel>{translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.395e541d5d", "Statuses")}</DropdownMenuLabel>
        <div className="space-y-2 px-1 pb-1">
          {workspaceStatuses.map((status, index) => {
            const meta = getWorkspaceStatusVisualMeta(status)
            return (
              <div
                key={status.id}
                className="rounded-md border border-border/70 bg-background/40 p-1.5"
              >
                <div className="flex items-center gap-1">
                  <meta.icon className={cn('size-3.5 shrink-0', meta.tone)} />
                  <input
                    defaultValue={status.label}
                    onBlur={(event) => onRenameStatus(status.id, event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.8ce44af9a8", "Rename {{value0}}", { value0: status.label })}
                  />
                  <WorkspaceStatusAppearancePopover
                    status={status}
                    onChangeColor={onChangeStatusColor}
                    onChangeIcon={onChangeStatusIcon}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7"
                    disabled={index === 0}
                    onClick={() => onMoveStatus(status.id, -1)}
                    aria-label={translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.b45b350eb0", "Move {{value0}} left", { value0: status.label })}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7"
                    disabled={index === workspaceStatuses.length - 1}
                    onClick={() => onMoveStatus(status.id, 1)}
                    aria-label={translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.b45b350eb0", "Move {{value0}} right", { value0: status.label })}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    disabled={workspaceStatuses.length <= 1}
                    onClick={() => onRemoveStatus(status.id)}
                    aria-label={translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.054cb50df7", "Remove {{value0}}", { value0: status.label })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-1 h-7 w-full justify-start text-[12px]"
            onClick={onAddStatus}
          >
            <Plus className="size-3.5" />
            {translate("auto.components.sidebar.WorkspaceKanbanSettingsMenu.79eb990aa4", "Add status")}</Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
