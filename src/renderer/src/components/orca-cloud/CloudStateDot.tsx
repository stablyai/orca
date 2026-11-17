import React from 'react'
import { cn } from '@/lib/class-names'
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
  // Light: amber nudged toward the foreground just enough for 3:1 on the sidebar; dark: plain amber.
  unresponsive:
    'rounded-full bg-[color-mix(in_srgb,var(--status-warning)_85%,var(--foreground))] dark:bg-status-warning',
  // Starting a new sandbox reads like waking (half-filled), without implying it slept before.
  starting:
    'rounded-full border-[1.5px] border-foreground bg-[linear-gradient(90deg,var(--foreground)_50%,transparent_50%)] motion-safe:animate-pulse',
  // Outlined square: at 1x a filled square read the same as the filled running circle.
  archived: 'rounded-[1px] border-[1.5px] border-muted-foreground bg-transparent',
  failed: 'rounded-full bg-destructive',
  // A failed wake: the workspace is fine, so a hollow destructive ring rather than a solid failure.
  wakeFailed: 'rounded-full border-[1.5px] border-destructive bg-transparent',
  unknown: 'rounded-full border-[1.5px] border-dashed border-muted-foreground bg-transparent'
}

export function CloudStateDot({
  state,
  size = 'sm',
  className
}: {
  state: CloudDotState
  /** badge: the 7px corner dot on a 12px host glyph. */
  size?: 'badge' | 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-cloud-state={state}
      className={cn(
        'inline-block shrink-0',
        size === 'md' ? 'size-2' : size === 'badge' ? 'size-[7px]' : 'size-1.5',
        CLOUD_DOT_CLASS[state],
        className
      )}
    />
  )
}
