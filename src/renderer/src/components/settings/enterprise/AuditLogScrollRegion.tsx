import type React from 'react'

/**
 * A long audit history scrolls in place so the settings page keeps its length: the header, export
 * and filters stay above it, and Show more pages in at the bottom. About ten rows (384px), or 60%
 * of the window when that is smaller. The top edge is ruled so more reads as more, and it runs to
 * the card's edges so the scrollbar sits against the card border. Focusable so the keyboard can
 * scroll it.
 */
export function AuditLogScrollRegion({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-audit-log-scroll=""
      className="-mx-5 max-h-[min(24rem,60vh)] scrollbar-sleek overflow-y-auto overscroll-contain border-t border-border px-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  )
}
