// A status-bar segment that stands in for a minimized progress card (the app update's, a cloud
// move's): icon and short label; clicking it expands or minimizes the card again.
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function StatusBarCardToggle({
  icon,
  label,
  tooltip,
  ariaLabel,
  expanded,
  iconOnly,
  onToggle
}: {
  icon: React.ReactNode
  label: string
  tooltip: React.ReactNode
  ariaLabel: string
  expanded: boolean
  iconOnly: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
          aria-expanded={expanded}
        >
          {icon}
          {!iconOnly && <span className="text-[11px] tabular-nums">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
