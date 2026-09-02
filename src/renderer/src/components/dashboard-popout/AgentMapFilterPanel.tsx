import { ChevronDown, Filter, X } from 'lucide-react'
import { useState } from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceStatusVisualMeta } from '../sidebar/workspace-status'
import type { DashboardCard, DashboardFilterOptions } from '../../../../shared/dashboard-snapshot'
import {
  activeDashboardFilterCount,
  toggleDashboardFilter,
  type DashboardFilters,
  type DashboardReviewFilter
} from './agent-board-filtering'
import {
  AGENT_STATE_ROWS,
  agentStateLabel,
  projectOptions,
  REVIEW_OPTIONS,
  reviewCountsByState,
  reviewStateLabel,
  workspaceStatusOptions
} from './agent-dashboard-filter-options'
import {
  summarizeSelection,
  summarizeTimeRanges,
  type AgentMapSectionSummary
} from './agent-map-filter-summaries'
import { countAgentMapAgentTypes, countAgentMapCards } from './agent-map-filter'
import { AGENT_MAP_QUICK_VIEWS } from './agent-map-quick-views'
import { AGENT_MAP_TIME_FIELDS, type AgentMapTimeField } from './agent-map-time-filter'
import { AgentMapFilterCheckbox } from './AgentMapFilterCheckbox'
import { AgentMapFilterSection } from './AgentMapFilterSection'
import { AgentMapTimeRangeField } from './AgentMapTimeRangeField'
import type { AgentMapFilterControls } from './useAgentMapFilters'
import { timeFieldLabel } from './agent-map-filter-labels'

type AgentMapFilterPanelProps = {
  cards: DashboardCard[]
  shownCount: number
  filterOptions?: DashboardFilterOptions
  filters: DashboardFilters
  onFiltersChange: (filters: DashboardFilters) => void
  map: AgentMapFilterControls
  agentlessWorkspaceCount: number
  showAgentlessWorkspaces: boolean
  onShowAgentlessWorkspacesChange: (show: boolean) => void
  showOrchestrationLinks: boolean
  onShowOrchestrationLinksChange: (show: boolean) => void
}

type SectionId = 'quick' | 'state' | 'agent' | 'time' | 'workspace' | 'content'

export function AgentMapFilterPanel({
  cards,
  shownCount,
  filterOptions,
  filters,
  onFiltersChange,
  map,
  agentlessWorkspaceCount,
  showAgentlessWorkspaces,
  onShowAgentlessWorkspacesChange,
  showOrchestrationLinks,
  onShowOrchestrationLinksChange
}: AgentMapFilterPanelProps): React.JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<SectionId>>(() => new Set<SectionId>(['quick']))
  const toggleSection = (id: SectionId, next: boolean): void =>
    setOpen((current) => {
      const updated = new Set(current)
      if (next) {
        updated.add(id)
      } else {
        updated.delete(id)
      }
      return updated
    })

  const stateCounts = countAgentMapCards(cards)
  const agentTypeCounts = countAgentMapAgentTypes(cards)
  const projects = projectOptions(cards, filterOptions?.projects)
  const statuses = workspaceStatusOptions(cards, filterOptions?.workspaceStatuses)
  const reviewCounts = reviewCountsByState(cards)
  const agentTypes = [...agentTypeCounts.keys()]

  const boardActive = activeDashboardFilterCount(filters)
  const activeCount =
    boardActive +
    map.activeCount +
    (showAgentlessWorkspaces ? 1 : 0) +
    (showOrchestrationLinks ? 0 : 1)

  const clearAll = (): void => {
    onFiltersChange({ projects: [], workspaceStatuses: [], reviewStates: [] })
    map.reset()
    onShowAgentlessWorkspacesChange(false)
    onShowOrchestrationLinksChange(true)
    setOpen(new Set<SectionId>(['quick']))
  }
  const applyQuickView = (id: Parameters<typeof map.applyQuickView>[0]): void => {
    onFiltersChange({ projects: [], workspaceStatuses: [], reviewStates: [] })
    onShowAgentlessWorkspacesChange(false)
    onShowOrchestrationLinksChange(true)
    map.applyQuickView(id)
  }

  // Board-style facets: an empty list means "no filter", so the count is what is
  // explicitly picked rather than what survives.
  const pickedWorkspaceCount =
    filters.workspaceStatuses.length +
    filters.reviewStates.length +
    (showAgentlessWorkspaces ? 1 : 0)
  const workspaceSummary: AgentMapSectionSummary =
    pickedWorkspaceCount === 0
      ? { text: translate('dashboardPopout.map.filters.summaryAll', 'All'), active: false }
      : {
          text: translate('dashboardPopout.map.filters.summarySelected', '{{count}} selected', {
            count: pickedWorkspaceCount
          }),
          active: true
        }
  const projectSummary: AgentMapSectionSummary =
    filters.projects.length === 0
      ? { text: translate('dashboardPopout.map.filters.summaryAll', 'All'), active: false }
      : {
          text:
            filters.projects.length === 1
              ? (projects.find((p) => p.id === filters.projects[0])?.label ?? filters.projects[0])
              : translate('dashboardPopout.map.filters.summaryCount', '{{shown}} of {{total}}', {
                  shown: filters.projects.length,
                  total: projects.length
                }),
          active: true
        }

  return (
    <Popover>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex max-h-[min(34rem,calc(100vh-6rem))] w-80 flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="text-xs font-semibold">
            {translate('dashboardPopout.map.filters.title', 'Map controls')}
          </span>
          <button
            type="button"
            onClick={clearAll}
            disabled={activeCount === 0}
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {translate('dashboardPopout.map.filters.reset', 'Reset')}
          </button>
          <span className="ml-auto text-[11px] tabular-nums">
            <strong className="font-semibold">{shownCount}</strong>{' '}
            <span className="text-muted-foreground">
              {translate('dashboardPopout.map.filters.ofTotalAgents', 'of {{total}} agents shown', {
                total: cards.length
              })}
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-3 pb-3">
          <AgentMapFilterSection
            title={translate('dashboardPopout.map.filters.quickViews', 'Quick views')}
            summary={{ text: '', active: false }}
            open={open.has('quick')}
            onOpenChange={(next) => toggleSection('quick', next)}
          >
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MAP_QUICK_VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => applyQuickView(view.id)}
                  className="rounded-md bg-muted px-2 py-1 text-[11px] hover:bg-accent"
                >
                  {view.label()}
                </button>
              ))}
            </div>
          </AgentMapFilterSection>

          <AgentMapFilterSection
            title={translate('dashboardPopout.map.filters.showStates', 'Agent states')}
            summary={summarizeSelection(map.states, AGENT_STATE_ROWS.length, agentStateLabel)}
            open={open.has('state')}
            onOpenChange={(next) => toggleSection('state', next)}
          >
            {AGENT_STATE_ROWS.map(({ state, dotState }) => (
              <AgentMapFilterCheckbox
                key={state}
                label={agentStateLabel(state)}
                checked={map.states.has(state)}
                count={stateCounts[state]}
                onToggle={() => map.toggleState(state)}
                leading={<AgentStateDot state={dotState} size="md" />}
              />
            ))}
          </AgentMapFilterSection>

          {agentTypes.length > 1 ? (
            <AgentMapFilterSection
              title={translate('dashboardPopout.map.filters.agents', 'Agents')}
              summary={summarizeSelection(map.agentTypes, agentTypes.length, (id) => id)}
              open={open.has('agent')}
              onOpenChange={(next) => toggleSection('agent', next)}
            >
              {agentTypes.map((agentType) => (
                <AgentMapFilterCheckbox
                  key={agentType}
                  label={agentType}
                  checked={map.agentTypes.has(agentType)}
                  count={agentTypeCounts.get(agentType) ?? 0}
                  onToggle={() => map.toggleAgentType(agentType)}
                />
              ))}
            </AgentMapFilterSection>
          ) : null}

          <AgentMapFilterSection
            title={translate('dashboardPopout.map.filters.time', 'Time')}
            summary={summarizeTimeRanges(map.timeRanges, timeFieldLabel)}
            open={open.has('time')}
            onOpenChange={(next) => toggleSection('time', next)}
          >
            {AGENT_MAP_TIME_FIELDS.map((field: AgentMapTimeField) => (
              <AgentMapTimeRangeField
                key={field}
                label={timeFieldLabel(field)}
                range={map.timeRanges[field]}
                onChange={(range) => map.setTimeRange(field, range)}
              />
            ))}
            <button
              type="button"
              onClick={map.resetTimeRanges}
              className="px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
            >
              {translate('dashboardPopout.map.filters.resetRanges', 'Reset ranges')}
            </button>
          </AgentMapFilterSection>

          <AgentMapFilterSection
            title={translate('dashboardPopout.filters.project', 'Project')}
            summary={projectSummary}
            open={open.has('workspace')}
            onOpenChange={(next) => toggleSection('workspace', next)}
          >
            {projects.map((option) => (
              <AgentMapFilterCheckbox
                key={option.id}
                label={option.label}
                checked={filters.projects.includes(option.id)}
                count={option.count}
                onToggle={() =>
                  onFiltersChange({
                    ...filters,
                    projects: toggleDashboardFilter(filters.projects, option.id)
                  })
                }
              />
            ))}
          </AgentMapFilterSection>

          <AgentMapFilterSection
            title={translate('dashboardPopout.map.filters.workspace', 'Workspace')}
            summary={workspaceSummary}
            open={open.has('content')}
            onOpenChange={(next) => toggleSection('content', next)}
          >
            {statuses.map((option) => {
              const meta = getWorkspaceStatusVisualMeta({
                id: option.id,
                label: option.label,
                color: option.color
              })
              return (
                <AgentMapFilterCheckbox
                  key={option.id}
                  label={option.label}
                  checked={filters.workspaceStatuses.includes(option.id)}
                  count={option.count}
                  onToggle={() =>
                    onFiltersChange({
                      ...filters,
                      workspaceStatuses: toggleDashboardFilter(filters.workspaceStatuses, option.id)
                    })
                  }
                  leading={<span className={cn('size-2 rounded-full', meta.swatch)} />}
                />
              )
            })}
            <div className="my-1.5 border-t border-border" />
            {REVIEW_OPTIONS.map((option: DashboardReviewFilter) => (
              <AgentMapFilterCheckbox
                key={option}
                label={reviewStateLabel(option)}
                checked={filters.reviewStates.includes(option)}
                count={reviewCounts.get(option) ?? 0}
                onToggle={() =>
                  onFiltersChange({
                    ...filters,
                    reviewStates: toggleDashboardFilter(filters.reviewStates, option)
                  })
                }
              />
            ))}
            <div className="my-1.5 border-t border-border" />
            <AgentMapFilterCheckbox
              label={translate(
                'dashboardPopout.map.filters.agentlessWorkspaces',
                'Workspaces without agents'
              )}
              checked={showAgentlessWorkspaces}
              count={agentlessWorkspaceCount}
              onToggle={() => onShowAgentlessWorkspacesChange(!showAgentlessWorkspaces)}
            />
            <AgentMapFilterCheckbox
              label={translate(
                'dashboardPopout.map.filters.orchestrationLinks',
                'Orchestration links'
              )}
              checked={showOrchestrationLinks}
              count={0}
              onToggle={() => onShowOrchestrationLinksChange(!showOrchestrationLinks)}
            />
          </AgentMapFilterSection>

          {activeCount > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
              {translate('dashboardPopout.filters.clearAll', 'Clear all filters')}
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
