import React from 'react'
import { cn } from '@/lib/utils'

/**
 * Amber unread dot overlaid on a status glyph. Callers own the offset; the parent must be `relative`.
 * Why ring-sidebar: it cuts the dot out from busy icons underneath.
 */
export function UnreadAlertBadge({
  className,
  ...rest
}: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      {...rest}
      className={cn(
        'pointer-events-none absolute rounded-full bg-unread-alert ring-2 ring-sidebar',
        className
      )}
    />
  )
}
