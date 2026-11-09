import React from 'react'
import { cn } from '@/lib/utils'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

/**
 * The one palette for Orca Cloud state, shared by the sidebar badge, the panel and the views.
 * Shape carries state too (hollow = asleep, half = waking, dashed = checking, square = archived), so the dot
 * reads without color; every hollow variant uses a strong enough stroke for light mode.
 */
export const CLOUD_DOT_CLASS: Record<CloudDotState, string> = {
  running: 'rounded-full bg-muted-foreground',
  sleeping: 'rounded-full border-[1.5px] border-muted-foreground bg-transparent',
  // Half-filled, so it differs from running even with the pulse off (reduced motion).
  waking:
    'rounded-full border-[1.5px] border-foreground bg-[linear-gradient(90deg,var(--foreground)_50%,transparent_50%)] motion-safe:animate-pulse',
  unresponsive: 'rounded-full bg-status-warning-text',
  archived: 'rounded-[2px] bg-muted-foreground',
  failed: 'rounded-full bg-destructive',
  unknown: 'rounded-full border-[1.5px] border-dashed border-muted-foreground bg-transparent'
}

export function CloudStateDot({
  state,
  size = 'sm',
  className
}: {
  state: CloudDotState
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-cloud-state={state}
      className={cn(
        'inline-block shrink-0',
        size === 'md' ? 'size-2' : 'size-1.5',
        CLOUD_DOT_CLASS[state],
        className
      )}
    />
  )
}
