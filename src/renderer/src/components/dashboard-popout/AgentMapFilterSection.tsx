import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentMapSectionSummary } from './agent-map-filter-summaries'

type AgentMapFilterSectionProps = {
  title: string
  /** Shown collapsed, so a closed row still says what it is doing. */
  summary: AgentMapSectionSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

export function AgentMapFilterSection({
  title,
  summary,
  open,
  onOpenChange,
  children
}: AgentMapFilterSectionProps): React.JSX.Element {
  // A section doing something stays open: a collapsed row must never be the
  // reason the map looks smaller than the filters claim.
  const expanded = open || summary.active
  return (
    <div className="border-t border-border first:border-t-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onOpenChange(!expanded)}
        className={cn(
          'flex w-full items-center gap-1.5 py-2 text-left',
          'text-[10px] font-semibold uppercase tracking-wider',
          'text-muted-foreground hover:text-foreground'
        )}
      >
        <ChevronRight
          className={cn('size-3 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
        <span>{title}</span>
        {!expanded ? (
          <span
            className={cn(
              'ml-auto text-[11px] font-normal normal-case tracking-normal tabular-nums',
              summary.active ? 'text-foreground' : 'text-muted-foreground/80'
            )}
          >
            {summary.text}
          </span>
        ) : null}
      </button>
      {expanded ? <div className="pb-2.5">{children}</div> : null}
    </div>
  )
}
