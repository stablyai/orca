import type React from 'react'
import { cn } from '@/lib/class-names'
import { useScrollEdgeFades } from '@/lib/list-interaction/use-scroll-edge-fades'

/**
 * A long audit history scrolls in place so the settings page keeps its length: the header, export
 * and filters stay above it, and Show more pages in at the bottom. About ten rows (384px), or 60%
 * of the window when that is smaller. The top edge is ruled so more reads as more, and it runs to
 * the card's edges so the scrollbar sits against the card border. Focusable so the keyboard can
 * scroll it.
 *
 * Rows fade out at an edge only while there is more past it (scrolled down, or more below), so
 * they don't cut off sharply under the filters. The fade is a mask on the scroller: it changes no
 * layout and catches no clicks. The rule and focus ring sit on the unmasked frame so they never
 * fade with it.
 */
export function AuditLogScrollRegion({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const fades = useScrollEdgeFades<HTMLDivElement>()
  return (
    <div className="-mx-5 border-t border-border has-[>[data-audit-log-scroll]:focus-visible]:ring-2 has-[>[data-audit-log-scroll]:focus-visible]:ring-inset has-[>[data-audit-log-scroll]:focus-visible]:ring-ring/50">
      <div
        ref={fades.ref}
        data-audit-log-scroll=""
        className={cn(
          'max-h-[min(24rem,60vh)] scrollbar-sleek overflow-y-auto overscroll-contain px-5 focus-visible:outline-none',
          fades.className
        )}
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  )
}
