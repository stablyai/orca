import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A menu item that is off for a reason: the reason shows as its tooltip and its accessible name. */
export function MenuItemBlockedReason({
  reason,
  label,
  side,
  render
}: {
  /** Null when the item is offered. */
  reason: string | null
  label: string
  side: 'left' | 'right'
  render: (props: { disabled: boolean; 'aria-label'?: string }) => React.JSX.Element
}): React.JSX.Element {
  if (!reason) {
    return render({ disabled: false })
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Disabled items ignore pointer events; wrap for tooltip hover as WorktreeContextMenu does. */}
        <div>{render({ disabled: true, 'aria-label': `${label}. ${reason}` })}</div>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={8} className="max-w-72">
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}
