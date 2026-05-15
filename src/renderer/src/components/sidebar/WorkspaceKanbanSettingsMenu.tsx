import React from 'react'
import { ArrowDown, ArrowUp, Pin, Plus, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import { getWorkspaceStatusVisualMeta } from './workspace-status'

type WorkspaceKanbanSettingsMenuProps = {
  opacityPercent: number
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onOpacityChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  onRenameStatus: (statusId: string, label: string) => void
  onMoveStatus: (statusId: string, direction: -1 | 1) => void
  onRemoveStatus: (statusId: string) => void
  onAddStatus: () => void
}

export default function WorkspaceKanbanSettingsMenu({
  opacityPercent,
  workspaceStatuses,
  onOpacityChange,
  onRenameStatus,
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
      <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-2">
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
        <div className="space-y-1 px-1 pb-1">
          <div className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground">
            <Pin className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Pinned</span>
            <span className="text-[10px]">Always first</span>
          </div>
          {workspaceStatuses.map((status, index) => {
            const meta = getWorkspaceStatusVisualMeta(status.id)
            return (
              <div key={status.id} className="flex items-center gap-1">
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
