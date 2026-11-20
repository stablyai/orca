import React from 'react'
import { cn } from '@/lib/class-names'

// The ring is paused in CSS and stepped by the looping-animation clock; callers provide size.
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      data-agent-spinner=""
      className={cn(
        // Fill the top under reduced motion so the frozen ring looks intentional (#9515).
        'agent-working-spinner block rounded-full border-2 border-agent-working border-t-transparent motion-reduce:border-t-agent-working',
        className
      )}
    />
  )
}
