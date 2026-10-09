import React from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export function AutomationArgsCell({
  value,
  effective = false
}: {
  value: string | undefined
  effective?: boolean
}): React.JSX.Element {
  const label = effective
    ? translate(
        'auto.components.automations.argumentColumns.effective',
        'Effective agent arguments (host defaults + extras)'
      )
    : translate('auto.components.automations.argumentColumns.saved', 'Saved extra arguments')
  if (value === undefined || !value.trim()) {
    return (
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {value === undefined
          ? translate('auto.components.automations.argumentColumns.unknown', 'Unknown')
          : translate('auto.components.automations.argumentColumns.none', 'None')}
      </span>
    )
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`${label}: ${value}`}
              className="pointer-events-auto min-w-0 max-w-48 justify-start"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {value}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <div className="max-w-sm">
            <div className="mb-1 text-xs">{label}</div>
            <div className="whitespace-pre-wrap break-all font-mono text-xs">{value}</div>
          </div>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        aria-label={label}
        className="w-96 max-w-[calc(100vw-2rem)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="p-3">
          <div className="mb-2 text-xs text-muted-foreground">{label}</div>
          <div
            tabIndex={0}
            className="scrollbar-sleek max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs"
          >
            {value}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
