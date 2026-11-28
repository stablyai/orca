import React from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** One active filter on a rail page ("Status: Paused ×"); shown next to the Filter button or in the notice band. */
export function RailPageFilterPill({
  label,
  value,
  onClear,
  removeLabel
}: {
  label: string
  value: string
  onClear: () => void
  /** Overrides "Remove <label> filter" when the value names what is removed. */
  removeLabel?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="max-w-[140px] truncate font-medium">{value}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-words">
          {value}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={
          removeLabel ??
          t(
            'auto.components.automations.AutomationListFilterMenu.removeFilter',
            'Remove {{value0}} filter',
            { value0: label }
          )
        }
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}
