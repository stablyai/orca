import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

function getConflictCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.right.sidebar.SourceControl.f71ea9e6e4', '1 conflict')
    : translate('auto.components.right.sidebar.SourceControl.1a9a7c183c', '{{value0}} conflicts', {
        value0: count
      })
}

export function SectionHeader({
  label,
  count,
  conflictCount = 0,
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  conflictCount?: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  // Why: wrap the toggle button and actions in a shared rounded container
  // so the hover background spans the entire row instead of clipping around
  // the label. The outer div keeps the vertical spacing that separates
  // sections; the inner wrapper owns the hover rectangle.
  return (
    <div className="pl-1 pr-3 pt-3 pb-1">
      <div className="group/section flex items-center rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 group-hover/section:text-accent-foreground"
          onClick={onToggle}
        >
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
          />
          <span>{label}</span>
          <span className="text-[11px] font-medium tabular-nums">{count}</span>
          {conflictCount > 0 && (
            <span className="text-[11px] font-medium text-destructive/80">
              · {getConflictCountLabel(conflictCount)}
            </span>
          )}
        </button>
        <div className="shrink-0 flex items-center">{actions}</div>
      </div>
    </div>
  )
}
