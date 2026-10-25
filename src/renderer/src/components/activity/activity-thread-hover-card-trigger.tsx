import type React from 'react'
import { HoverCardTrigger } from '@/components/ui/hover-card'
import { useActivityThreadHoverCardIntent } from './activity-thread-hover-card-intent'

type ActivityThreadHoverCardTriggerProps = {
  children: React.ReactElement
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ActivityThreadHoverCardTrigger({
  children,
  open,
  onOpenChange
}: ActivityThreadHoverCardTriggerProps): React.JSX.Element {
  const intent = useActivityThreadHoverCardIntent({ open, onOpenChange })

  return (
    <HoverCardTrigger
      asChild
      data-hover-card-resting={intent.resting ? '' : undefined}
      {...intent.triggerHandlers}
    >
      {children}
    </HoverCardTrigger>
  )
}
