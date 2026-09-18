import React from 'react'
import { ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FilterOptionCount } from '../dashboard-popout/FilterOptionCount'
import { sessionGridStateLabel } from './session-grid-state-label'
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
  // turn — a spinner claims work nobody does.
  return <AgentStateDot state={BUCKET_GLYPH[filter]} size="sm" title={null} paused={count === 0} />
}

type SessionGridStateControlProps = {
  stateCounts: SessionGridBucketCounts
  activeStateFilter: SessionGridStateFilter
  className?: string
}

/** Attention remains one click away while the menu holds the complete state list. */
export function SessionGridAttentionButton({
  stateCounts,
  activeStateFilter
}: SessionGridStateControlProps): React.JSX.Element {
  const setSessionsGridStateFilter = useAppStore((s) => s.setSessionsGridStateFilter)
  const active = activeStateFilter === 'attention'
  const label = sessionGridStateLabel('attention')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="xs"
          data-testid="session-grid-attention"
          aria-label={`${label} ${stateCounts.attention}`}
          aria-pressed={active}
          onClick={() => setSessionsGridStateFilter(active ? 'all' : 'attention')}
        >
          <StateGlyph filter="attention" count={stateCounts.attention} />
          <span className="@max-xl/toolbar:!hidden">{label}</span>
          <span className="tabular-nums">{stateCounts.attention}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function SessionGridStateCompactMenu({
  stateCounts,
  activeStateFilter,
  className
}: SessionGridStateControlProps): React.JSX.Element {
  const setSessionsGridStateFilter = useAppStore((s) => s.setSessionsGridStateFilter)
  const activeLabel = sessionGridStateLabel(activeStateFilter)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          data-testid="session-grid-state-compact"
          aria-label={translate(
            'auto.components.session.grid.SessionGridStateControl.compactLabel',
            'State: {{value0}}',
            { value0: activeLabel }
          )}
          className={className}
        >
          <StateGlyph
            filter={activeStateFilter}
            count={stateFilterCount(activeStateFilter, stateCounts)}
          />
          <span className="inline-flex items-baseline gap-1.5">
            <span>{activeLabel}</span>
            {/* Under 384 px (a 600 px window with the sidebar at its widest) the row is 16 px short:
                the count and the chevron are what it can spare. */}
            <span className="text-[11px] tabular-nums text-muted-foreground @max-sm/toolbar:!hidden">
              {stateFilterCount(activeStateFilter, stateCounts)}
            </span>
          </span>
          <ChevronDown className="size-3 text-muted-foreground @max-sm/toolbar:!hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>
          {translate('auto.components.session.grid.SessionGridStateControl.group', 'State')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeStateFilter}
          onValueChange={(value) => {
            const filter = SESSION_GRID_STATE_FILTERS.find((candidate) => candidate === value)
            if (filter) {
              setSessionsGridStateFilter(filter)
            }
          }}
        >
          {SESSION_GRID_STATE_FILTERS.map((filter) => (
            <DropdownMenuRadioItem
              key={filter}
              value={filter}
              data-testid="session-grid-state-option"
              data-value={filter}
            >
              <StateGlyph filter={filter} count={stateFilterCount(filter, stateCounts)} />
              <span>{sessionGridStateLabel(filter)}</span>
              <FilterOptionCount count={stateFilterCount(filter, stateCounts)} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
