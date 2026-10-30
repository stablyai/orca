import React from 'react'
import { DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { SwitchIndicator } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

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
        // Avoid px-* because Tailwind v4 padding-inline outranks physical pl-* indentation.
        'flex w-full items-start justify-between gap-2 rounded-[5px] py-1.5 pr-2 text-left text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        indented ? 'pl-7' : 'pl-2'
      )}
    >
      <span
        className={cn(
          'inline-flex items-start gap-2',
          indented ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        <span className="text-muted-foreground mt-0.5">{icon}</span>
        {label}
      </span>
      <span className="inline-flex items-center gap-2 mt-0.5">
        {shortcutLabel ? <DropdownMenuShortcut>{shortcutLabel}</DropdownMenuShortcut> : null}
        <SwitchIndicator
          checked={checked}
          size="compact"
          className="data-[state=checked]:bg-primary"
        />
      </span>
    </button>
  )
}
