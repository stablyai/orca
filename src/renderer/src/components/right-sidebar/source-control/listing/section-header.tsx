import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function SectionHeader({
  label,
  count,
  countTitle,
  conflictCount = 0,
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  /** Spells out what the count measures — e.g. files changed against a compare base. */
  countTitle?: string
  conflictCount?: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  // Why: shared rounded container so the hover background spans the whole row instead of clipping around the label.
  return (
    <div className="pl-1 pr-3 pt-3 pb-1">
      <div className="group/section flex flex-wrap items-center gap-x-1 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto min-h-6 min-w-0 flex-auto justify-start gap-x-1 gap-y-0 py-0.5 text-left font-semibold uppercase tracking-wider text-foreground/70 group-hover/section:text-accent-foreground"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
        >
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1">
              <span className="min-w-0 whitespace-normal break-words">{label}</span>
              {/* Why: no aria-label here — inside the toggle button it would rewrite the
              button's accessible name; the explanation stays a hover-only title. */}
              <span className="shrink-0 text-[11px] font-medium tabular-nums" title={countTitle}>
                {count}
              </span>
            </span>
            {conflictCount > 0 && (
              <span className="block whitespace-normal text-[11px] font-medium text-destructive/80">
                {conflictCount}{' '}
                {translate('auto.components.right.sidebar.SourceControl.413a3ba113', 'conflict')}
                {conflictCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
        </Button>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end">{actions}</div>
      </div>
    </div>
  )
}
