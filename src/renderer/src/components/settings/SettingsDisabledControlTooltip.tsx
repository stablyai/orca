import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** Explains why a settings control is disabled; renders the control untouched without a reason. */
export function SettingsDisabledControlTooltip({
  reason,
  children
}: {
  reason?: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!reason) {
    return <>{children}</>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Disabled controls drop hover events, so an enabled wrapper carries the tooltip. */}
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}
