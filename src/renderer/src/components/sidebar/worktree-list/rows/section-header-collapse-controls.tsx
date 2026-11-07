import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { handleRepoHeaderCollapseAffordancePointerDown } from './header-event-guards'

export function SectionHeaderCollapseToggle({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
      data-repo-header-collapse-affordance=""
      aria-hidden
      onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle(event)
      }}
    >
      <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
    </div>
  )
}

/** At-rest marker for a collapsed header; the hover-only toggle can't tell collapsed from empty. */
export function SectionHeaderCollapsedSummary({
  count
}: {
  count: number | null
}): React.JSX.Element {
  return (
    <div
      data-section-header-collapsed-summary=""
      className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
    >
      {count !== null ? <span className="text-2xs tabular-nums leading-4">{count}</span> : null}
      {/* Touch keeps the toggle in flow, so a second chevron would be redundant there. */}
      <ChevronRight className="size-3.5 not-can-hover:hidden" aria-hidden />
    </div>
  )
}
