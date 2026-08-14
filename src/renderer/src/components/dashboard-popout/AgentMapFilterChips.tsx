import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { DashboardFilters } from './agent-board-filtering'
import { timeFieldLabel } from './agent-map-filter-labels'
import { agentStateLabel, reviewStateLabel } from './agent-dashboard-filter-options'
import {
  activeAgentMapTimeFields,
  agentMapTimeStopLabel,
  FULL_AGENT_MAP_TIME_RANGE
} from './agent-map-time-filter'
import type { AgentMapFilterControls } from './useAgentMapFilters'

type Chip = { id: string; label: string; onRemove: () => void }

type AgentMapFilterChipsProps = {
  map: AgentMapFilterControls
  filters: DashboardFilters
  onFiltersChange: (filters: DashboardFilters) => void
  projectLabel: (id: string) => string
  statusLabel: (id: string) => string
  showAgentlessWorkspaces: boolean
  onShowAgentlessWorkspacesChange: (show: boolean) => void
  showOrchestrationLinks: boolean
  onShowOrchestrationLinksChange: (show: boolean) => void
  onClear: () => void
}

/** Every active facet as a removable chip. The panel's collapsed summaries say
 *  what is filtered; these are how you undo one without reopening the panel. */
export function AgentMapFilterChips({
  map,
  filters,
  onFiltersChange,
  projectLabel,
  statusLabel,
  showAgentlessWorkspaces,
  onShowAgentlessWorkspacesChange,
  showOrchestrationLinks,
  onShowOrchestrationLinksChange,
  onClear
}: AgentMapFilterChipsProps): React.JSX.Element | null {
  const chips: Chip[] = []
  const drop = <T extends string>(values: T[], value: T): T[] => values.filter((v) => v !== value)

  for (const id of filters.projects) {
    chips.push({
      id: `project:${id}`,
      label: projectLabel(id),
      onRemove: () => onFiltersChange({ ...filters, projects: drop(filters.projects, id) })
    })
  }
  for (const id of filters.workspaceStatuses) {
    chips.push({
      id: `status:${id}`,
      label: statusLabel(id),
      onRemove: () =>
        onFiltersChange({ ...filters, workspaceStatuses: drop(filters.workspaceStatuses, id) })
    })
  }
  for (const id of filters.reviewStates) {
    chips.push({
      id: `review:${id}`,
      label: translate('dashboardPopout.filters.reviewChip', 'Review: {{state}}', {
        state: reviewStateLabel(id)
      }),
      onRemove: () => onFiltersChange({ ...filters, reviewStates: drop(filters.reviewStates, id) })
    })
  }
  if (map.states.size < 4) {
    chips.push({
      id: 'states',
      label: translate('dashboardPopout.map.filters.stateChip', 'State: {{states}}', {
        states: [...map.states].map(agentStateLabel).join(', ')
      }),
      onRemove: map.resetStates
    })
  }
  for (const field of activeAgentMapTimeFields(map.timeRanges)) {
    const range = map.timeRanges[field]
    chips.push({
      id: `time:${field}`,
      label: `${timeFieldLabel(field)}: ${agentMapTimeStopLabel(range.min)}–${agentMapTimeStopLabel(range.max)}`,
      onRemove: () => map.setTimeRange(field, { ...FULL_AGENT_MAP_TIME_RANGE })
    })
  }
  if (map.unreadOnly) {
    chips.push({
      id: 'unread',
      label: translate('dashboardPopout.map.quickView.unread', 'Unread'),
      onRemove: () => map.setUnreadOnly(false)
    })
  }
  if (map.orchestrationOnly) {
    chips.push({
      id: 'orchestration',
      label: translate('dashboardPopout.map.quickView.orchestration', 'Orchestration'),
      onRemove: () => map.setOrchestrationOnly(false)
    })
  }
  if (showAgentlessWorkspaces) {
    chips.push({
      id: 'agentless',
      label: translate(
        'dashboardPopout.map.filters.agentlessWorkspaces',
        'Workspaces without agents'
      ),
      onRemove: () => onShowAgentlessWorkspacesChange(false)
    })
  }
  if (!showOrchestrationLinks) {
    chips.push({
      id: 'orchestration-links',
      label: translate(
        'dashboardPopout.map.filters.orchestrationLinksHidden',
        'Orchestration links hidden'
      ),
      onRemove: () => onShowOrchestrationLinksChange(true)
    })
  }
  // Agent chips need the option universe to know what "all" is, so they ride
  // the panel's summary rather than a chip.

  if (chips.length === 0) {
    return null
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted py-0.5 pr-1 pl-2 text-[11px]"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={translate('dashboardPopout.filters.removeChip', 'Remove {{filter}}', {
              filter: chip.label
            })}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="xs" onClick={onClear} className="h-5 px-1.5 text-[11px]">
        {translate('dashboardPopout.filters.clear', 'Clear')}
      </Button>
    </div>
  )
}
