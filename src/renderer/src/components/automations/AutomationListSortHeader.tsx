import React from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AutomationListSort, AutomationListSortField } from './automation-list-view'

export function AutomationListSortHeader({
  field,
  label,
  sort,
  onSort
}: {
  field: AutomationListSortField
  label: string
  sort: AutomationListSort | null
  onSort: (field: AutomationListSortField) => void
}): React.JSX.Element {
  const active = sort?.field === field
  const direction = active ? sort.direction : null
  const directionLabel =
    direction === 'asc'
      ? translate('auto.components.automations.AutomationListSortHeader.ascending', 'ascending')
      : direction === 'desc'
        ? translate('auto.components.automations.AutomationListSortHeader.descending', 'descending')
        : null
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={directionLabel ? `${label}, ${directionLabel}` : label}
      aria-pressed={active}
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-sm text-left text-[11px] font-medium tracking-[0.08em] uppercase select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        active && 'text-foreground'
      )}
    >
      <span className="truncate">{label}</span>
      {direction === 'asc' ? <ArrowUp aria-hidden="true" className="size-3 shrink-0" /> : null}
      {direction === 'desc' ? <ArrowDown aria-hidden="true" className="size-3 shrink-0" /> : null}
    </button>
  )
}
