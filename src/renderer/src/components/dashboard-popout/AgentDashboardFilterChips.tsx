import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { DashboardFilters, DashboardReviewFilter } from './agent-board-filtering'

type FilterLabel = { id: string; label: string }

function ActiveChip({
  label,
  onRemove
}: {
  label: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border bg-muted/55 pr-1 pl-2 text-[11px]">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={translate('dashboardPopout.filters.remove', 'Remove {{label}} filter', {
          label
        })}
        className="rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function AgentDashboardFilterChips({
  filters,
  projects,
  statuses,
  reviewLabel,
  onProjectToggle,
  onStatusToggle,
  onReviewToggle,
  onClear
}: {
  filters: DashboardFilters
  projects: FilterLabel[]
  statuses: FilterLabel[]
  reviewLabel: (id: DashboardReviewFilter) => string
  onProjectToggle: (id: string) => void
  onStatusToggle: (id: string) => void
  onReviewToggle: (id: DashboardReviewFilter) => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('dashboardPopout.filters.active', 'Filters')}
      </span>
      {filters.projects.map((id) => (
        <ActiveChip
          key={`project:${id}`}
          label={projects.find((option) => option.id === id)?.label ?? id}
          onRemove={() => onProjectToggle(id)}
        />
      ))}
      {filters.workspaceStatuses.map((id) => (
        <ActiveChip
          key={`status:${id}`}
          label={statuses.find((option) => option.id === id)?.label ?? id}
          onRemove={() => onStatusToggle(id)}
        />
      ))}
      {filters.reviewStates.map((id) => (
        <ActiveChip
          key={`review:${id}`}
          label={reviewLabel(id)}
          onRemove={() => onReviewToggle(id)}
        />
      ))}
      <Button
        variant="link"
        size="xs"
        onClick={onClear}
        className="h-[22px] px-1 text-[11px] text-muted-foreground"
      >
        {translate('dashboardPopout.filters.clear', 'Clear')}
      </Button>
    </div>
  )
}
