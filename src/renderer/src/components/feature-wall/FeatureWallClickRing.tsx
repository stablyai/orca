import type { JSX } from 'react'
import { cn } from '@/lib/utils'

export function FeatureWallClickRing(props: { className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'feature-wall-click-ring pointer-events-none absolute -left-1.5 -top-1.5 size-7 rounded-full border-2 border-foreground/50',
        props.className
      )}
    />
  )
}
