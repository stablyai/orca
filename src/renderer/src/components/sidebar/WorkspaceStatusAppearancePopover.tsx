import React from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  WORKSPACE_STATUS_COLOR_OPTIONS,
  WORKSPACE_STATUS_ICON_OPTIONS,
  getWorkspaceStatusVisualMeta
} from './workspace-status'

type WorkspaceStatusAppearancePopoverProps = {
  status: WorkspaceStatusDefinition
  onChangeColor: (statusId: string, color: string) => void
  onChangeIcon: (statusId: string, icon: string) => void
}

export default function WorkspaceStatusAppearancePopover({
  status,
  onChangeColor,
  onChangeIcon
}: WorkspaceStatusAppearancePopoverProps): React.JSX.Element {
  const meta = getWorkspaceStatusVisualMeta(status)

  return (
    <Popover modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="relative size-7"
              aria-label={`Customize ${status.label} appearance`}
            >
              <span className={cn('absolute size-4 rounded-full opacity-20', meta.swatch)} />
              <meta.icon className={cn('relative size-3.5', meta.tone)} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Appearance
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="left"
        sideOffset={8}
        className="w-72 p-2"
        data-workspace-status-appearance-popover=""
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-1 py-1 text-[11px] font-semibold text-muted-foreground">Color</div>
        <div className="grid grid-cols-4 gap-1">
          {WORKSPACE_STATUS_COLOR_OPTIONS.map((color) => (
            <Tooltip key={color.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
                    status.color === color.id && 'border-ring bg-accent'
                  )}
                  onClick={() => onChangeColor(status.id, color.id)}
                  aria-label={`Set ${status.label} color to ${color.label}`}
                >
                  <span className={cn('size-3 rounded-full', color.swatch)} />
                  <span className="min-w-0 truncate">{color.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {color.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="mt-2 px-1 py-1 text-[11px] font-semibold text-muted-foreground">Icon</div>
        <div className="grid grid-cols-6 gap-1">
          {WORKSPACE_STATUS_ICON_OPTIONS.map((icon) => (
            <Tooltip key={icon.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={status.icon === icon.id ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  className="size-8"
                  onClick={() => onChangeIcon(status.id, icon.id)}
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
      </PopoverContent>
    </Popover>
  )
}
