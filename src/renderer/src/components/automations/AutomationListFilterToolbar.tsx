import React from 'react'
import { Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AutomationListFilterState } from '@/store/slices/ui'

type AutomationListFilterToolbarProps = {
  filter: AutomationListFilterState
  onSearchChange: (search: string) => void
  onStatusChange: (status: AutomationListFilterState['status']) => void
  onFailedOnlyChange: (failedOnly: boolean) => void
}

type StatusChip = {
  value: AutomationListFilterState['status']
  label: string
}

function FilterChip({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  // Why: chips are toggle controls, so they get button semantics + aria-pressed
  // rather than the decorative Badge defaults; styling tracks the documented
  // selected-row treatment (accent fill when active, ghost-hover when idle).
  return (
    <Badge
      asChild
      variant={active ? 'secondary' : 'outline'}
      className={cn(
        'cursor-pointer select-none px-2 py-0.5 transition-colors',
        active ? 'border-foreground/30' : 'hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <button type="button" aria-pressed={active} onClick={onClick}>
        {label}
      </button>
    </Badge>
  )
}

export function AutomationListFilterToolbar({
  filter,
  onSearchChange,
  onStatusChange,
  onFailedOnlyChange
}: AutomationListFilterToolbarProps): React.JSX.Element {
  const statusChips: StatusChip[] = [
    {
      value: 'all',
      label: translate('auto.components.automations.AutomationListFilterToolbar.all', 'All')
    },
    {
      value: 'enabled',
      label: translate('auto.components.automations.AutomationListFilterToolbar.running', 'Running')
    },
    {
      value: 'paused',
      label: translate('auto.components.automations.AutomationListFilterToolbar.paused', 'Paused')
    }
  ]

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter.search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={translate(
            'auto.components.automations.AutomationListFilterToolbar.searchPlaceholder',
            'Search name or prompt'
          )}
          className="h-8 pl-8 pr-8 text-xs"
          aria-label={translate(
            'auto.components.automations.AutomationListFilterToolbar.searchAria',
            'Search automations'
          )}
        />
        {filter.search ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label={translate(
              'auto.components.automations.AutomationListFilterToolbar.clearSearch',
              'Clear search'
            )}
            className="absolute right-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {statusChips.map((chip) => (
          <FilterChip
            key={chip.value}
            active={filter.status === chip.value}
            label={chip.label}
            onClick={() => onStatusChange(chip.value)}
          />
        ))}
        <span className="mx-0.5 h-4 w-px bg-border/60" aria-hidden />
        <FilterChip
          active={filter.failedOnly}
          label={translate(
            'auto.components.automations.AutomationListFilterToolbar.failedLastRun',
            'Failed last run'
          )}
          onClick={() => onFailedOnlyChange(!filter.failedOnly)}
        />
      </div>
    </div>
  )
}
