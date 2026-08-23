// Why: shared drill-in chrome for the collapsed Filters popover (section list,
// clear-all row, back header) so the GitHub PR toolbar and the Linear issue
// toolbar stay visually congruent instead of copying the markup.
import React from 'react'
import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type FilterSectionRow<K extends string> = {
  key: K
  label: string
  value: string | null
}

export function FilterSectionMenu<K extends string>({
  heading,
  rows,
  onPick,
  onClearAll
}: {
  /** ReactNode, not string: call sites keep the explicit {' '} between a translated
   * fragment and the value after it (see i18n-jsx-spacing-guard). */
  heading: React.ReactNode
  rows: FilterSectionRow<K>[]
  onPick: (key: K) => void
  onClearAll: (() => void) | null
}): React.JSX.Element {
  return (
    <div className="py-1 text-xs">
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => onPick(row.key)}
          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50"
        >
          <span>{row.label}</span>
          <span className="flex items-center gap-1 text-muted-foreground">
            {row.value ? <span className="max-w-[140px] truncate">{row.value}</span> : null}
            <ChevronRight className="size-3.5" />
          </span>
        </button>
      ))}
      {onClearAll ? (
        <>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={onClearAll}
            className="w-full px-3 py-1.5 text-left text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
          >
            {translate('auto.components.task.filter.section.menu.5a186cbca7', 'Clear all filters')}
          </button>
        </>
      ) : null}
    </div>
  )
}

export function FilterSectionBackButton({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-full items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
    >
      <ChevronRight className="size-3 rotate-180" />
      {translate('auto.components.task.filter.section.menu.615d9351d4', 'Back')}
    </button>
  )
}
