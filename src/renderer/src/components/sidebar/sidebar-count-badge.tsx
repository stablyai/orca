import React from 'react'
import { cn } from '@/lib/utils'

/** Corner count pill overlaying its relative parent; absolute so it never
 *  affects layout (frozen-width surfaces like the view toggle depend on this). */
export function SidebarCountBadge({
  count,
  className
}: {
  count: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground',
        className
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}
