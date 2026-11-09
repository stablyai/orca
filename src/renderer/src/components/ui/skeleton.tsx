import type React from 'react'
import { cn } from '@/lib/utils'

/**
 * Loading placeholder shaped like the content it stands in for. Uses the --skeleton token so it
 * stays visible on white cards; the pulse stops under reduced motion. It is aria-hidden, so mark the
 * loading container aria-busy or give it sr-only "Loading…" text.
 */
const SKELETON_SHAPES = {
  rounded: 'rounded-md',
  /** Thin lines (terminal rows, labels) that read better with a tighter corner. */
  small: 'rounded-sm',
  circle: 'rounded-full'
} as const

const SKELETON_MOTION = {
  pulse: 'motion-safe:animate-pulse',
  /** A slower breath for long waits, so the placeholder doesn't feel frantic. */
  slow: 'motion-safe:animate-pulse [animation-duration:2.4s]',
  /** Static: a bar standing in for a value that is not loading (e.g. an empty meter). */
  still: ''
} as const

function Skeleton({
  className,
  shape = 'rounded',
  motion = 'pulse',
  ...props
}: React.ComponentProps<'div'> & {
  shape?: keyof typeof SKELETON_SHAPES
  motion?: keyof typeof SKELETON_MOTION
}): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(SKELETON_SHAPES[shape], 'bg-skeleton', SKELETON_MOTION[motion], className)}
      {...props}
    />
  )
}

export { Skeleton }
