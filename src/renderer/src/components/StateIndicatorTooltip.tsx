import type { ComponentProps, ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const STATE_INDICATOR_TOOLTIP_DELAY_MS = 200
export type StateIndicatorTooltipSide = ComponentProps<typeof TooltipContent>['side']

export function StateIndicatorTooltip({
  label,
  side = 'top',
  children
}: {
  label: string | null
  side?: StateIndicatorTooltipSide
  children: ReactElement
}): React.JSX.Element {
  if (label === null) {
    return children
  }

  return (
    <Tooltip delayDuration={STATE_INDICATOR_TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
