import { ChevronDown, Filter, Search, X } from 'lucide-react'
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
import { AgentDashboardFilterChips } from './AgentDashboardFilterChips'

type FilterOption = { id: string; label: string; count: number; color?: string }

type AgentDashboardToolbarProps = {
  cards: DashboardCard[]
  filterOptions?: DashboardFilterOptions
  filteredCount: number
  query: string
  onQueryChange: (query: string) => void
  filters: DashboardFilters
  onFiltersChange: (filters: DashboardFilters) => void
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
  onFiltersChange
}: AgentDashboardToolbarProps): React.JSX.Element {
  const projects = projectOptions(cards, filterOptions?.projects)
  const statuses = workspaceStatusOptions(cards, filterOptions?.workspaceStatuses)
  const reviewCounts = countBy(
    cards,
    (card) => card.review?.state ?? (card.hasReview ? 'unknown' : 'none')
  )
  const activeCount = activeDashboardFilterCount(filters)
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
  const clearFilters = (): void =>
    onFiltersChange({ projects: [], workspaceStatuses: [], reviewStates: [] })
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
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={translate(
              'dashboardPopout.search.placeholder',
              'Search worktree, project, or agent…'
            )}
            aria-label={translate('dashboardPopout.search.label', 'Search agents')}
            className="h-7 bg-muted/55 pr-7 pl-7 text-xs"
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
          ) : null}
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
          onProjectToggle={toggleProject}
          onStatusToggle={toggleStatus}
          onReviewToggle={toggleReview}
          onClear={clearFilters}
        />
      ) : null}
    </>
  )
}
