import React from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

export type RailPageSortDirection = 'asc' | 'desc'

export type RailPageSort<F extends string> = {
  field: F
  direction: RailPageSortDirection
}

/** A list-table header label that orders its column; the arrow marks the active column's direction. */
export function RailPageSortHeader<F extends string>({
  field,
  label,
  sort,
  onSort
}: {
  field: F
  label: string
  sort: RailPageSort<F> | null
  onSort: (field: F) => void
}): React.JSX.Element {
  const t = useTranslate()
  const active = sort?.field === field
  const direction = active ? sort.direction : null
  // Translate whole direction labels because column placement/punctuation varies by language.
  const sortedLabel =
    direction === 'asc'
      ? t(
          'auto.components.automations.AutomationListSortHeader.sortedAscending',
          '{{value0}}, sorted ascending',
          { value0: label }
        )
      : direction === 'desc'
        ? t(
            'auto.components.automations.AutomationListSortHeader.sortedDescending',
            '{{value0}}, sorted descending',
            { value0: label }
          )
        : null
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={sortedLabel ?? label}
      className={cn(
        'flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-[11px] font-medium tracking-[0.08em] uppercase select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        active && 'text-foreground'
      )}
    >
      <span className="truncate">{label}</span>
      {direction === 'asc' ? <ArrowUp aria-hidden="true" className="size-3 shrink-0" /> : null}
      {direction === 'desc' ? <ArrowDown aria-hidden="true" className="size-3 shrink-0" /> : null}
    </button>
  )
}
