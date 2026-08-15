import React from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  countAutomationListFilters,
  EMPTY_AUTOMATION_LIST_FILTER,
  type AutomationListFilter,
  type AutomationListLastRunFilter,
  type AutomationListStatusFilter
} from './automation-list-view'

function FilterPill({
  label,
  value,
  onClear
}: {
  label: string
  value: string
  onClear: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[140px] truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={translate(
          'auto.components.automations.AutomationListFilterMenu.removeFilter',
          'Remove {{value0}} filter',
          { value0: label }
        )}
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function AutomationListFilterPills({
  filter,
  onChange
}: {
  filter: AutomationListFilter
  onChange: (next: AutomationListFilter) => void
}): React.JSX.Element | null {
  const statusLabel = translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')
  const lastRunLabel = translate(
    'auto.components.automations.AutomationsPage.tableLastRun',
    'Last run'
  )
  const statusValueLabel =
    filter.status === 'enabled'
      ? translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')
      : filter.status === 'paused'
        ? translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')
        : null
  const lastRunValueLabel =
    filter.lastRun === 'failed'
      ? translate('auto.components.automations.AutomationListFilterMenu.failed', 'Failed')
      : filter.lastRun === 'succeeded'
        ? translate('auto.components.automations.AutomationListFilterMenu.succeeded', 'Succeeded')
        : filter.lastRun === 'never'
          ? translate('auto.components.automations.AutomationListFilterMenu.neverRan', 'Never ran')
          : null
  if (!statusValueLabel && !lastRunValueLabel) {
    return null
  }
  return (
    <>
      {statusValueLabel ? (
        <FilterPill
          label={statusLabel}
          value={statusValueLabel}
          onClear={() => onChange({ ...filter, status: 'all' })}
        />
      ) : null}
      {lastRunValueLabel ? (
        <FilterPill
          label={lastRunLabel}
          value={lastRunValueLabel}
          onClear={() => onChange({ ...filter, lastRun: 'all' })}
        />
      ) : null}
    </>
  )
}

export function AutomationListFilterMenu({
  filter,
  onChange
}: {
  filter: AutomationListFilter
  onChange: (next: AutomationListFilter) => void
}): React.JSX.Element {
  const activeCount = countAutomationListFilters(filter)
  const statusLabel = translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')
  const lastRunLabel = translate(
    'auto.components.automations.AutomationsPage.tableLastRun',
    'Last run'
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 border border-border bg-background px-2.5 text-xs shadow-none hover:bg-muted/50 focus-visible:border-ring/70 focus-visible:ring-0"
        >
          <ListFilter className="size-3.5" />
          {translate('auto.components.automations.AutomationListFilterMenu.filters', 'Filters')}
          {activeCount > 0 ? (
            <span className="rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-4 text-background">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>{statusLabel}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.status}
          onValueChange={(value) =>
            onChange({ ...filter, status: value as AutomationListStatusFilter })
          }
        >
          <DropdownMenuRadioItem value="all">
            {translate('auto.components.automations.AutomationListFilterMenu.all', 'All')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="enabled">
            {translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="paused">
            {translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{lastRunLabel}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.lastRun}
          onValueChange={(value) =>
            onChange({ ...filter, lastRun: value as AutomationListLastRunFilter })
          }
        >
          <DropdownMenuRadioItem value="all">
            {translate('auto.components.automations.AutomationListFilterMenu.all', 'All')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="failed">
            {translate('auto.components.automations.AutomationListFilterMenu.failed', 'Failed')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="succeeded">
            {translate(
              'auto.components.automations.AutomationListFilterMenu.succeeded',
              'Succeeded'
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="never">
            {translate(
              'auto.components.automations.AutomationListFilterMenu.neverRan',
              'Never ran'
            )}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(EMPTY_AUTOMATION_LIST_FILTER)}>
              {translate(
                'auto.components.automations.AutomationListFilterMenu.clear',
                'Clear filters'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
