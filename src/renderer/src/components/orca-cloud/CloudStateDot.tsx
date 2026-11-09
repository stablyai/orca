import React from 'react'
import { cn } from '@/lib/utils'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

// Shape carries state too (hollow = asleep, square = archived), so the dot reads without color.
const DOT: Record<CloudDotState, string> = {
  running: 'rounded-full bg-emerald-500',
  sleeping: 'rounded-full border border-muted-foreground/70 bg-transparent',
  waking: 'rounded-full bg-sky-500 motion-safe:animate-pulse',
  unresponsive: 'rounded-full bg-amber-500',
  archived: 'rounded-[1px] bg-muted-foreground/50',
  failed: 'rounded-full bg-destructive',
  unknown: 'rounded-full bg-muted-foreground/30'
}

export function CloudStateDot({
  state,
  className
}: {
  state: CloudDotState
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-cloud-state={state}
      className={cn('inline-block size-1.5 shrink-0', DOT[state], className)}
    />
  )
}
