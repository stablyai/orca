// Why: shared closeable filter pill used by the GitHub PR toolbar and the
// Linear issue toolbar so active-filter affordances stay visually congruent
// across task providers.
import React from 'react'
import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type TaskFilterPillProps = {
  label: string
  value: string
  onClear: () => void
}

export function TaskFilterPill({ label, value, onClear }: TaskFilterPillProps): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[160px] truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={translate(
          'auto.components.task.filter.pill.6b2c72c3ca',
          'Remove {{value0}} filter',
          { value0: label }
        )}
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}
