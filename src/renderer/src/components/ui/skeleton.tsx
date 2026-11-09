import type React from 'react'
import { cn } from '@/lib/utils'

/**
 * Loading placeholder shaped like the content it stands in for. Uses the --skeleton token so it
 * stays visible on white cards; the pulse stops under reduced motion. It is aria-hidden, so mark the
 * loading container aria-busy or give it sr-only "Loading…" text.
 */
function Skeleton({
  className,
  shape = 'rounded',
  ...props
}: React.ComponentProps<'div'> & { shape?: 'rounded' | 'circle' }): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        'bg-skeleton motion-safe:animate-pulse',
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
