import React from 'react'
import { DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/**
 * Switch row shared by the two workspace-filter surfaces (the sidebar filter
 * dropdown and the workspace options menu). Extracted so the two copies cannot
 * drift as rows are added.
 */
export function FilterToggleRow({
  icon,
  label,
  ariaLabel,
  checked,
  onChange,
  shortcutLabel,
  indented = false
}: {
  icon: React.ReactNode
  label: string
  /** Full sentence for assistive tech when `label` only reads in visual context. */
  ariaLabel?: string
  checked: boolean
  onChange: (next: boolean) => void
  shortcutLabel?: string
  /** Renders the row as a sub-option of the row above it. */
  indented?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        // Why pl-* and not px-2 + pl-6: Tailwind v4 emits px as padding-inline,
        // which outranks a physical pl-6 override and flattens the indent.
        'flex w-full items-center justify-between gap-2 rounded-[5px] py-1.5 pr-2 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        indented ? 'pl-7' : 'pl-2'
      )}
    >
      <span
        className={cn(
          'inline-flex items-center gap-2',
          indented ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </span>
      <span className="inline-flex items-center gap-2">
        {shortcutLabel ? <DropdownMenuShortcut>{shortcutLabel}</DropdownMenuShortcut> : null}
        <span
          aria-hidden
          className={cn(
            'relative h-3.5 w-6 shrink-0 rounded-full transition-colors',
            checked ? 'bg-primary' : 'bg-muted-foreground/30'
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform',
              checked && 'translate-x-2.5'
            )}
          />
        </span>
      </span>
    </button>
  )
}

export default FilterToggleRow
