import React from 'react'
import { ArrowDown, ArrowUp, Plus, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  WORKSPACE_STATUS_COLOR_OPTIONS,
  WORKSPACE_STATUS_ICON_OPTIONS,
  getWorkspaceStatusVisualMeta
} from './workspace-status'

type WorkspaceKanbanSettingsMenuProps = {
  opacityPercent: number
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onOpacityChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  onRenameStatus: (statusId: string, label: string) => void
  onChangeStatusColor: (statusId: string, color: string) => void
  onChangeStatusIcon: (statusId: string, icon: string) => void
  onMoveStatus: (statusId: string, direction: -1 | 1) => void
  onRemoveStatus: (statusId: string) => void
  onAddStatus: () => void
}

export default function WorkspaceKanbanSettingsMenu({
  opacityPercent,
  workspaceStatuses,
  onOpacityChange,
  onRenameStatus,
  onChangeStatusColor,
  onChangeStatusIcon,
  onMoveStatus,
  onRemoveStatus,
  onAddStatus
}: WorkspaceKanbanSettingsMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Workspace board settings">
          <Settings2 className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="max-h-[min(80vh,720px)] w-80 overflow-y-auto p-2 scrollbar-sleek"
      >
        <DropdownMenuLabel>Board opacity</DropdownMenuLabel>
        <div className="px-2 pb-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Pane opacity</span>
            <span>{opacityPercent}%</span>
          </div>
          <input
            type="range"
            min={20}
            max={100}
            value={opacityPercent}
            onChange={onOpacityChange}
            className="h-5 w-full accent-foreground"
            aria-label="Workspace board opacity"
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Statuses</DropdownMenuLabel>
        <div className="space-y-2 px-1 pb-1">
          {workspaceStatuses.map((status, index) => {
            const meta = getWorkspaceStatusVisualMeta(status)
            return (
              <div
                key={status.id}
                className="space-y-1.5 rounded-md border border-border/70 bg-background/40 p-1.5"
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
                    aria-label={`Rename ${status.label}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7"
                    disabled={index === 0}
                    onClick={() => onMoveStatus(status.id, -1)}
                    aria-label={`Move ${status.label} left`}
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
                    aria-label={`Move ${status.label} right`}
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
                    aria-label={`Remove ${status.label}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  {WORKSPACE_STATUS_COLOR_OPTIONS.map((color) => (
                    <Tooltip key={color.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            'flex size-5 items-center justify-center rounded-full border border-transparent',
                            status.color === color.id && 'border-ring bg-accent'
                          )}
                          onClick={() => onChangeStatusColor(status.id, color.id)}
                          aria-label={`Set ${status.label} color to ${color.label}`}
                        >
                          <span className={cn('size-3 rounded-full', color.swatch)} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>
                        {color.label}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {WORKSPACE_STATUS_ICON_OPTIONS.map((icon) => (
                    <Tooltip key={icon.id}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant={status.icon === icon.id ? 'secondary' : 'ghost'}
                          size="icon-xs"
                          className="size-7"
                          onClick={() => onChangeStatusIcon(status.id, icon.id)}
                          aria-label={`Set ${status.label} icon to ${icon.label}`}
                        >
                          <icon.icon className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>
                        {icon.label}
                      </TooltipContent>
                    </Tooltip>
                  ))}
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
            Add status
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
