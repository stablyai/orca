import React from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  getWorkspaceStatusColorOptions,
  getWorkspaceStatusIconOptions,
  getWorkspaceStatusVisualMeta
} from './workspace-status'
import { translate } from '@/i18n/i18n'

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
              aria-label={translate(
                'auto.components.sidebar.WorkspaceStatusAppearancePopover.ccbd1e2c69',
                'Customize {{value0}} appearance',
                { value0: status.label }
              )}
            >
              <span className={cn('absolute size-4 rounded-full opacity-20', meta.swatch)} />
              <meta.icon className={cn('relative size-3.5', meta.tone)} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate(
            'auto.components.sidebar.WorkspaceStatusAppearancePopover.74b1413279',
            'Appearance'
          )}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="left"
        sideOffset={8}
        className="z-[80] w-72 p-2"
        data-workspace-status-appearance-popover=""
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-1 py-1 text-[11px] font-semibold text-muted-foreground">
          {translate(
            'auto.components.sidebar.WorkspaceStatusAppearancePopover.2ac106f6b2',
            'Color'
          )}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {getWorkspaceStatusColorOptions().map((color) => (
            <Tooltip key={color.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex size-8 items-center justify-center rounded-md border border-transparent outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
                    status.color === color.id && 'border-ring bg-accent'
                  )}
                  onClick={() => onChangeColor(status.id, color.id)}
                  aria-label={translate(
                    'auto.components.sidebar.WorkspaceStatusAppearancePopover.514be2f569',
                    'Set {{value0}} color to {{value1}}',
                    { value0: status.label, value1: color.label }
                  )}
                >
                  <span className={cn('size-3.5 rounded-full', color.swatch)} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {color.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="mt-2 px-1 py-1 text-[11px] font-semibold text-muted-foreground">
          {translate('auto.components.sidebar.WorkspaceStatusAppearancePopover.8be427206b', 'Icon')}
        </div>
        <div className="grid grid-cols-6 gap-1">
          {getWorkspaceStatusIconOptions().map((icon) => (
            <Tooltip key={icon.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={status.icon === icon.id ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  className="size-8"
                  onClick={() => onChangeIcon(status.id, icon.id)}
                  aria-label={translate(
                    'auto.components.sidebar.WorkspaceStatusAppearancePopover.514be2f569',
                    'Set {{value0}} icon to {{value1}}',
                    { value0: status.label, value1: icon.label }
                  )}
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
