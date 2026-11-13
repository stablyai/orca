import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useSourceControlScope } from '../panel/worktree-scope'

export function SectionHeader({
  label,
  count,
  countTitle,
  conflictCount = 0,
  status,
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  /** Spells out what the count measures — e.g. files changed against a compare base. */
  countTitle?: string
  conflictCount?: number
  /** Inline status after the count; part of the toggle's accessible name. */
  status?: React.ReactNode
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  // Folder cards keep the gap above the first file equal to the one below the last.
  const compact = useSourceControlScope() !== null
  // Share the rounded container so hover styling spans the whole row.
  return (
    <div
      className={cn(
        'pl-1 pr-3 pt-3',
        compact ? 'pb-0' : 'pb-1',
        // Status chips size against the whole row, so long action labels don't shrink them early.
        status && '@container/section-header'
      )}
    >
      <div className="group/section flex items-center gap-x-1 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
        <Button
          type="button"
          variant="ghost"
          size={compact ? 'chip' : 'xs'}
          className={cn(
            'h-auto min-w-0 flex-1 justify-start text-left',
            compact ? 'min-h-4' : 'min-h-6'
          )}
          onClick={onToggle}
          aria-expanded={!isCollapsed}
        >
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
          />
          <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-foreground/70 group-hover/section:text-accent-foreground">
            <span className="flex min-w-0 items-center gap-1">
              {/* With a status chip, keep a few title characters readable before chip and count. */}
              <span className={cn('truncate', status ? 'min-w-[4ch]' : 'min-w-0')} title={label}>
                {label}
              </span>
              {/* Use title only; aria-label here would replace the parent toggle's accessible name. */}
              <span className="shrink-0 text-[11px] font-medium tabular-nums" title={countTitle}>
                {count}
              </span>
              {status}
            </span>
            {conflictCount > 0 && (
              <span className="block truncate text-[11px] font-medium text-destructive/80">
                {t(
                  'auto.components.right.sidebar.SourceControl.conflictCount',
                  '{{count}} conflicts',
                  { count: conflictCount, defaultValue_one: '{{count}} conflict' }
                )}
              </span>
            )}
          </span>
        </Button>
        <div className={cn('ml-auto flex shrink-0 items-center justify-end', compact && '-my-1')}>
          {actions}
        </div>
      </div>
    </div>
  )
}
