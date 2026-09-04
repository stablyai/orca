import React from 'react'
import { ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { FilterOptionCount } from '../dashboard-popout/FilterOptionCount'
import { agentStateLabel } from '../dashboard-popout/agent-dashboard-filter-options'
import type { SessionGridBucketCounts } from './session-grid-items-builder'
import type { SessionGridStateFilter } from '../../../../shared/session-grid-types'
import { SESSION_GRID_STATE_FILTERS } from '../../../../shared/session-grid-types'
import { translate } from '@/i18n/i18n'

type Bucket = Exclude<SessionGridStateFilter, 'all'>

/**
 * The glyph each bucket borrows from the dashboard's dot vocabulary, so "needs you" is the
 * same orange here, on the card and on the offscreen pill. `all` has no glyph: its word is it.
 */
const BUCKET_GLYPH: Record<Bucket, AgentDotState> = {
  attention: 'permission',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

function stateFilterLabel(filter: SessionGridStateFilter): string {
  return filter === 'all'
    ? translate('auto.components.session.grid.SessionGridStateControl.all', 'All')
    : agentStateLabel(filter)
}

function stateFilterCount(filter: SessionGridStateFilter, counts: SessionGridBucketCounts): number {
  return filter === 'all'
    ? counts.attention + counts.working + counts.done + counts.idle
    : counts[filter]
}

function StateGlyph({
  filter,
  count
}: {
  filter: SessionGridStateFilter
  count: number
}): React.JSX.Element | null {
  if (filter === 'all') {
    return null
  }
  // The label sits right beside it, so the dot's own tooltip would only repeat it. And the
  // working glyph is an activity spinner: here it names a bucket, so over a zero it must not
  // turn — a spinner claims work nobody does. Stopped, it also closes its ring: a frozen
  // transparent-top ring reads as a broken spinner, the same call AgentWorkingSpinner makes
  // under reduced motion (#9515).
  return (
    <AgentStateDot
      state={BUCKET_GLYPH[filter]}
      size="sm"
      title={null}
      className={cn(
        count === 0 &&
          '[&_.agent-working-spinner]:[animation-play-state:paused] [&_.agent-working-spinner]:border-t-yellow-500'
      )}
    />
  )
}

type SessionGridStateControlProps = {
  stateCounts: SessionGridBucketCounts
  activeStateFilter: SessionGridStateFilter
  className?: string
}

/**
 * The state axis as one segmented control: single-choice, so one piece and not five chips,
 * and the fleet's glance value, so it carries the glyph and the count in every width. The
 * word is what goes first when the toolbar narrows — `@max-4xl/toolbar` is the toolbar's own
 * container, so the collapse follows the space the sidebar leaves, not the window. 896 px is
 * where the full row (icons, picker, five labelled segments, pager, view) stops fitting.
 */
export function SessionGridStateSegments({
  stateCounts,
  activeStateFilter,
  className
}: SessionGridStateControlProps): React.JSX.Element {
  const setSessionsGridStateFilter = useAppStore((s) => s.setSessionsGridStateFilter)
  return (
    <div
      role="group"
      aria-label={translate('auto.components.session.grid.SessionGridStateControl.group', 'State')}
      className={cn(
        'inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/80 bg-background/50',
        className
      )}
    >
      {SESSION_GRID_STATE_FILTERS.map((filter) => {
        const isActive = activeStateFilter === filter
        const count = stateFilterCount(filter, stateCounts)
        const label = stateFilterLabel(filter)
        return (
          <button
            key={filter}
            type="button"
            data-testid="session-grid-state-chip"
            data-value={filter}
            data-current={isActive ? 'true' : undefined}
            aria-pressed={isActive}
            aria-label={`${label} ${count}`}
            title={label}
            onClick={() => setSessionsGridStateFilter(filter)}
            className={cn(
              'inline-flex items-center gap-1.5 border-r border-border/60 px-2 text-xs transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
              isActive
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <StateGlyph filter={filter} count={count} />
            <span className={cn(filter !== 'all' && '@max-4xl/toolbar:!hidden')}>{label}</span>
            <span
              className={cn(
                'font-mono text-[11px] tabular-nums',
                count === 0 && !isActive && 'opacity-50'
              )}
            >
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The same axis folded into one button for the narrow toolbar, under 576 px: shows the
 * active state, opens the list. Same order, same labels, same counts.
 */
export function SessionGridStateCompactMenu({
  stateCounts,
  activeStateFilter,
  className
}: SessionGridStateControlProps): React.JSX.Element {
  const setSessionsGridStateFilter = useAppStore((s) => s.setSessionsGridStateFilter)
  const activeLabel = stateFilterLabel(activeStateFilter)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="session-grid-state-compact"
          aria-label={translate(
            'auto.components.session.grid.SessionGridStateControl.compactLabel',
            'State: {{value0}}',
            { value0: activeLabel }
          )}
          className={cn('h-7 gap-1.5 px-2 text-xs border-border/80 bg-background/50', className)}
        >
          <StateGlyph
            filter={activeStateFilter}
            count={stateFilterCount(activeStateFilter, stateCounts)}
          />
          <span>{activeLabel}</span>
          {/* Under 384 px (a 600 px window with the sidebar at its widest) the row is 16 px short:
              the count and the chevron are what it can spare. */}
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground @max-sm/toolbar:!hidden">
            {stateFilterCount(activeStateFilter, stateCounts)}
          </span>
          <ChevronDown className="size-3 text-muted-foreground @max-sm/toolbar:!hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.session.grid.SessionGridStateControl.group', 'State')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeStateFilter}
          onValueChange={(value) => setSessionsGridStateFilter(value as SessionGridStateFilter)}
        >
          {SESSION_GRID_STATE_FILTERS.map((filter) => (
            <DropdownMenuRadioItem
              key={filter}
              value={filter}
              data-testid="session-grid-state-option"
              data-value={filter}
              className="gap-2 text-xs"
            >
              <StateGlyph filter={filter} count={stateFilterCount(filter, stateCounts)} />
              <span>{stateFilterLabel(filter)}</span>
              <FilterOptionCount count={stateFilterCount(filter, stateCounts)} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
