import { ChevronDown, Filter, Search, X } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceStatusVisualMeta } from '../sidebar/workspace-status'
import type {
  DashboardCard,
  DashboardFilterOption,
  DashboardFilterOptions
} from '../../../../shared/dashboard-snapshot'
import {
  activeDashboardFilterCount,
  type DashboardFilters,
  type DashboardReviewFilter,
  toggleDashboardFilter
} from './agent-board-filtering'
import { countAgentMapCards, type AgentMapState } from './agent-map-filter'
import { AgentDashboardFilterChips } from './AgentDashboardFilterChips'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'

type FilterOption = { id: string; label: string; count: number; color?: string }

type AgentDashboardToolbarProps = {
  cards: DashboardCard[]
  filterOptions?: DashboardFilterOptions
  filteredCount: number
  query: string
  onQueryChange: (query: string) => void
  filters: DashboardFilters
  onFiltersChange: (filters: DashboardFilters) => void
  /** Map-only: the board's columns already separate agents by state. */
  agentStates?: ReadonlySet<AgentMapState>
  onAgentStateToggle?: (state: AgentMapState) => void
  onAgentStatesReset?: () => void
  showAgentlessWorkspaces?: boolean
  agentlessWorkspaceCount?: number
  onShowAgentlessWorkspacesChange?: (show: boolean) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

const AGENT_STATE_ROWS: {
  state: AgentMapState
  dotState: 'waiting' | 'working' | 'done' | 'idle'
}[] = [
  { state: 'attention', dotState: 'waiting' },
  { state: 'working', dotState: 'working' },
  { state: 'done', dotState: 'done' },
  { state: 'idle', dotState: 'idle' }
]

function agentStateLabel(state: AgentMapState): string {
  switch (state) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

function countBy(
  cards: DashboardCard[],
  value: (card: DashboardCard) => string
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    const key = value(card)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function workspaceStatusOptions(
  cards: DashboardCard[],
  configured: DashboardFilterOption[] | undefined
): FilterOption[] {
  const counts = countBy(cards, (card) => card.workspaceStatusId ?? '')
  if (configured) {
    return configured.map((option) => ({
      ...option,
      count: counts.get(option.id) ?? 0
    }))
  }
  const options = new Map<string, FilterOption>()
  for (const card of cards) {
    if (!card.workspaceStatusId || options.has(card.workspaceStatusId)) {
      continue
    }
    options.set(card.workspaceStatusId, {
      id: card.workspaceStatusId,
      label: card.workspaceStatusLabel ?? card.workspaceStatusId,
      color: card.workspaceStatusColor,
      count: counts.get(card.workspaceStatusId) ?? 0
    })
  }
  return [...options.values()]
}

function projectOptions(
  cards: DashboardCard[],
  configured: DashboardFilterOption[] | undefined
): FilterOption[] {
  const counts = countBy(cards, (card) => card.repoId)
  if (configured) {
    return configured.map((option) => ({
      ...option,
      count: counts.get(option.id) ?? 0
    }))
  }
  const options = new Map<string, FilterOption>()
  for (const card of cards) {
    if (!options.has(card.repoId)) {
      options.set(card.repoId, {
        id: card.repoId,
        label: card.repoName,
        count: counts.get(card.repoId) ?? 0
      })
    }
  }
  return [...options.values()]
}

const REVIEW_OPTIONS: readonly DashboardReviewFilter[] = [
  'open',
  'draft',
  'merged',
  'closed',
  'none'
]

function reviewStateLabel(state: DashboardReviewFilter): string {
  switch (state) {
    case 'open':
      return translate('dashboardPopout.filters.review.open', 'Open')
    case 'draft':
      return translate('dashboardPopout.filters.review.draft', 'Draft')
    case 'merged':
      return translate('dashboardPopout.filters.review.merged', 'Merged')
    case 'closed':
      return translate('dashboardPopout.filters.review.closed', 'Closed')
    case 'none':
      return translate('dashboardPopout.filters.review.none', 'No review')
  }
}

function OptionCount({ count }: { count: number }): React.JSX.Element {
  return <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{count}</span>
}

export function AgentDashboardToolbar({
  cards,
  filterOptions,
  filteredCount,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  agentStates,
  onAgentStateToggle,
  onAgentStatesReset,
  showAgentlessWorkspaces,
  agentlessWorkspaceCount = 0,
  onShowAgentlessWorkspacesChange,
  searchInputRef
}: AgentDashboardToolbarProps): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const projects = projectOptions(cards, filterOptions?.projects)
  const statuses = workspaceStatusOptions(cards, filterOptions?.workspaceStatuses)
  const reviewCounts = countBy(
    cards,
    (card) => card.review?.state ?? (card.hasReview ? 'unknown' : 'none')
  )
  const agentStateCounts = agentStates ? countAgentMapCards(cards) : null
  // A muted state is an active filter, so the badge counts them like the rest.
  const mutedStateCount = agentStates ? AGENT_STATE_ROWS.length - agentStates.size : 0
  const activeCount =
    activeDashboardFilterCount(filters) +
    mutedStateCount +
    (showAgentlessWorkspaces === true ? 1 : 0)
  const toggleProject = (id: string): void =>
    onFiltersChange({ ...filters, projects: toggleDashboardFilter(filters.projects, id) })
  const toggleStatus = (id: string): void =>
    onFiltersChange({
      ...filters,
      workspaceStatuses: toggleDashboardFilter(filters.workspaceStatuses, id)
    })
  const toggleReview = (id: DashboardReviewFilter): void =>
    onFiltersChange({
      ...filters,
      reviewStates: toggleDashboardFilter(filters.reviewStates, id)
    })
  const clearFilters = (): void => {
    onFiltersChange({ projects: [], workspaceStatuses: [], reviewStates: [] })
    onAgentStatesReset?.()
    onShowAgentlessWorkspacesChange?.(false)
  }
  const reviewLabel = (id: DashboardReviewFilter): string =>
    translate('dashboardPopout.filters.reviewChip', 'Review: {{state}}', {
      state: reviewStateLabel(id)
    })

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={translate(
              'dashboardPopout.search.placeholder',
              'Search worktree, project, or agent…'
            )}
            aria-label={translate('dashboardPopout.search.label', 'Search agents')}
            className="h-7 bg-muted/55 pr-16 pl-7 text-xs"
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onQueryChange('')}
              aria-label={translate('dashboardPopout.search.clear', 'Clear search')}
              className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
            >
              <X className="size-3" />
            </Button>
          ) : (
            <ShortcutKeyCombo
              keys={[isMac ? '⌘' : 'Ctrl', 'K']}
              className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2"
              keyCapClassName="min-w-4 px-1 py-0 text-[9px] shadow-none"
              separatorClassName="text-[9px] text-muted-foreground"
            />
          )}
        </div>
        {query || activeCount > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {translate('dashboardPopout.search.results', '{{shown}} of {{total}} shown', {
              shown: filteredCount,
              total: cards.length
            })}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={cn('h-7 gap-1.5 px-2 text-xs', activeCount > 0 && 'border-foreground/25')}
            >
              <Filter className="size-3" />
              {translate('dashboardPopout.filters.label', 'Filter')}
              {activeCount > 0 ? (
                <span className="rounded-full bg-foreground px-1.5 py-px text-[10px] leading-none text-background">
                  {activeCount}
                </span>
              ) : null}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64" sideOffset={6}>
            {showAgentlessWorkspaces !== undefined && onShowAgentlessWorkspacesChange ? (
              <>
                <DropdownMenuLabel>
                  {translate('dashboardPopout.map.filters.workspaceVisibility', 'Map content')}
                </DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={showAgentlessWorkspaces}
                  onCheckedChange={(checked) => onShowAgentlessWorkspacesChange(checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="truncate">
                    {translate(
                      'dashboardPopout.map.filters.agentlessWorkspaces',
                      'Workspaces without agents'
                    )}
                  </span>
                  <OptionCount count={agentlessWorkspaceCount} />
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {agentStates && agentStateCounts ? (
              <>
                <DropdownMenuLabel>
                  {translate('dashboardPopout.map.filters.showStates', 'Agent states')}
                </DropdownMenuLabel>
                {AGENT_STATE_ROWS.map(({ state, dotState }) => (
                  <DropdownMenuCheckboxItem
                    key={state}
                    checked={agentStates.has(state)}
                    onCheckedChange={() => onAgentStateToggle?.(state)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <AgentStateDot state={dotState} size="md" />
                    <span className="truncate">{agentStateLabel(state)}</span>
                    <OptionCount count={agentStateCounts[state]} />
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuLabel>
              {translate('dashboardPopout.filters.project', 'Project')}
            </DropdownMenuLabel>
            {projects.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={filters.projects.includes(option.id)}
                onCheckedChange={() => toggleProject(option.id)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{option.label}</span>
                <OptionCount count={option.count} />
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {translate('dashboardPopout.filters.workspaceStatus', 'Workspace status')}
            </DropdownMenuLabel>
            {statuses.map((option) => {
              const meta = getWorkspaceStatusVisualMeta({
                id: option.id,
                label: option.label,
                color: option.color
              })
              return (
                <DropdownMenuCheckboxItem
                  key={option.id}
                  checked={filters.workspaceStatuses.includes(option.id)}
                  onCheckedChange={() => toggleStatus(option.id)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className={cn('size-2 rounded-full', meta.swatch)} />
                  <span className="truncate">{option.label}</span>
                  <OptionCount count={option.count} />
                </DropdownMenuCheckboxItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {translate('dashboardPopout.filters.reviewStatus', 'PR / MR status')}
            </DropdownMenuLabel>
            {REVIEW_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option}
                checked={filters.reviewStates.includes(option)}
                onCheckedChange={() => toggleReview(option)}
                onSelect={(event) => event.preventDefault()}
              >
                <span>{reviewStateLabel(option)}</span>
                <OptionCount count={reviewCounts.get(option) ?? 0} />
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={activeCount === 0}
              onSelect={clearFilters}
              className="text-muted-foreground"
            >
              <X className="size-3.5" />
              {translate('dashboardPopout.filters.clearAll', 'Clear all filters')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {activeCount > 0 ? (
        <AgentDashboardFilterChips
          filters={filters}
          projects={projects}
          statuses={statuses}
          reviewLabel={reviewLabel}
          showAgentlessWorkspaces={showAgentlessWorkspaces === true}
          onProjectToggle={toggleProject}
          onStatusToggle={toggleStatus}
          onReviewToggle={toggleReview}
          onAgentlessWorkspacesToggle={() => onShowAgentlessWorkspacesChange?.(false)}
          onClear={clearFilters}
        />
      ) : null}
    </>
  )
}
