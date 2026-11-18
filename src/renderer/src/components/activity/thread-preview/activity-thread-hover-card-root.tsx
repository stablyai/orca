import type React from 'react'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
import { useActivityThreadHoverCardIntent } from './activity-thread-hover-card-intent'

export function ActivityThreadHoverCardRoot({
  open,
  onOpenChange,
  openDelay,
  closeDelay,
  enabled = true,
  trigger,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  openDelay?: number
  closeDelay?: number
  enabled?: boolean
  trigger: React.ReactElement
  children: React.ReactNode
}): React.JSX.Element {
  const intent = useActivityThreadHoverCardIntent({ open, onOpenChange, openDelay, enabled })

  return (
    <HoverCard open={open} onOpenChange={intent.onOpenChange} openDelay={0} closeDelay={closeDelay}>
      <HoverCardTrigger
        asChild
        data-hover-card-resting={intent.resting ? '' : undefined}
        {...intent.triggerHandlers}
      >
        {trigger}
      </HoverCardTrigger>
      {children}
    </HoverCard>
  )
}
