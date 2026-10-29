import React from 'react'
import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsIteration,
  AzureDevOpsIterationTimeFrame,
  AzureDevOpsWorkItem
} from '../../../../../shared/azure-devops/boards-types'
import {
  EMPTY_BACKLOG_FILTERS,
  UNASSIGNED_FILTER_VALUE,
  isBacklogFilterEmpty,
  type BacklogFilters
} from '@/components/task-page-azure-devops-backlog-filters'

export type AzureDevOpsFilterOptions = {
  workItemTypes: string[]
  assignees: { key: string; label: string }[]
  states: string[]
  areaPaths: string[]
  iterations: AzureDevOpsIteration[]
  tags: string[]
}

export type TaskPageAzureDevOpsFiltersProps = {
  filters: BacklogFilters
  options: AzureDevOpsFilterOptions
  onChange: (next: BacklogFilters) => void
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

export function collectAzureDevOpsFilterOptions(
  items: AzureDevOpsWorkItem[],
  iterations: AzureDevOpsIteration[]
): AzureDevOpsFilterOptions {
  const assignees = new Map<string, string>()
  for (const item of items) {
    if (item.assignedTo?.uniqueName) {
      assignees.set(item.assignedTo.uniqueName, item.assignedTo.displayName)
    }
  }
  return {
    workItemTypes: sortedUnique(items.map((i) => i.workItemType)),
    assignees: [
      {
        key: UNASSIGNED_FILTER_VALUE,
        label: translate('auto.components.TaskPage.azureDevOps.unassigned', 'Unassigned')
      },
      ...Array.from(assignees, ([key, label]) => ({ key, label })).sort((a, b) =>
        a.label.localeCompare(b.label)
      )
    ],
    states: sortedUnique(items.map((i) => i.state)),
    areaPaths: sortedUnique(items.map((i) => i.areaPath).filter(Boolean)),
    iterations,
    tags: sortedUnique(items.flatMap((i) => i.tags))
  }
}

function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

function iterationTimeFrameLabel(timeFrame: AzureDevOpsIterationTimeFrame): string {
  switch (timeFrame) {
    case 'past':
      return translate('auto.components.TaskPage.azureDevOps.iterationPast', 'past')
    case 'current':
      return translate('auto.components.TaskPage.azureDevOps.iterationCurrent', 'current')
    case 'future':
      return translate('auto.components.TaskPage.azureDevOps.iterationFuture', 'future')
  }
}

function SetFilter({
  label,
  values,
  selected,
  onToggle
}: {
  label: string
  values: { key: string; label: string }[]
  selected: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={selected.size > 0 ? 'secondary' : 'ghost'} size="sm">
          {label}
          {selected.size > 0 ? (
            <span className="text-muted-foreground">({selected.size})</span>
          ) : null}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72">
        {values.map((value) => (
          <DropdownMenuCheckboxItem
            key={value.key}
            checked={selected.has(value.key)}
            onCheckedChange={() => onToggle(value.key)}
            // Why: multi-select — keep the menu open across picks, as the GitHub filters do.
            onSelect={(event) => event.preventDefault()}
          >
            {value.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TaskPageAzureDevOpsFilters({
  filters,
  options,
  onChange
}: TaskPageAzureDevOpsFiltersProps): React.JSX.Element {
  const asOptions = (values: string[]) => values.map((v) => ({ key: v, label: v }))
  const current = options.iterations.find((i) => i.timeFrame === 'current') ?? null
  const selectedIteration = options.iterations.find((i) => i.path === filters.iterationPath) ?? null
  const selectedIterationLabel =
    filters.iterationPath === null
      ? null
      : (selectedIteration?.name ??
        filters.iterationPath.split('\\').pop() ??
        filters.iterationPath)
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
      <Input
        value={filters.keyword}
        onChange={(event) => onChange({ ...filters, keyword: event.target.value })}
        placeholder={translate(
          'auto.components.TaskPage.azureDevOps.filterKeyword',
          'Filter by keyword'
        )}
        className="h-8 w-56"
      />
      <SetFilter
        label={translate('auto.components.TaskPage.azureDevOps.filterType', 'Type')}
        values={asOptions(options.workItemTypes)}
        selected={filters.workItemTypes}
        onToggle={(key) =>
          onChange({ ...filters, workItemTypes: toggle(filters.workItemTypes, key) })
        }
      />
      <SetFilter
        label={translate('auto.components.TaskPage.azureDevOps.filterAssignedTo', 'Assigned to')}
        values={options.assignees}
        selected={filters.assignedTo}
        onToggle={(key) => onChange({ ...filters, assignedTo: toggle(filters.assignedTo, key) })}
      />
      <SetFilter
        label={translate('auto.components.TaskPage.azureDevOps.filterStates', 'States')}
        values={asOptions(options.states)}
        selected={filters.states}
        onToggle={(key) => onChange({ ...filters, states: toggle(filters.states, key) })}
      />
      <SetFilter
        label={translate('auto.components.TaskPage.azureDevOps.filterArea', 'Area')}
        values={asOptions(options.areaPaths)}
        selected={filters.areaPaths}
        onToggle={(key) => onChange({ ...filters, areaPaths: toggle(filters.areaPaths, key) })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={filters.iterationPath !== null ? 'secondary' : 'ghost'} size="sm">
            {translate('auto.components.TaskPage.azureDevOps.filterIteration', 'Iteration')}
            {selectedIterationLabel ? (
              <span className="text-muted-foreground">{selectedIterationLabel}</span>
            ) : null}
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72">
          {current ? (
            <>
              <DropdownMenuItem
                onSelect={() => onChange({ ...filters, iterationPath: current.path })}
              >
                {translate(
                  'auto.components.TaskPage.azureDevOps.currentIteration',
                  'Current iteration'
                )}
                <span className="ml-2 text-muted-foreground">{current.name}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {options.iterations.map((iteration) => (
            <DropdownMenuItem
              key={iteration.id}
              onSelect={() => onChange({ ...filters, iterationPath: iteration.path })}
            >
              {iteration.name}
              {iteration.timeFrame ? (
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {iterationTimeFrameLabel(iteration.timeFrame)}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {filters.iterationPath ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange({ ...filters, iterationPath: null })}>
                {translate('auto.components.TaskPage.azureDevOps.clearIteration', 'Any iteration')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <SetFilter
        label={translate('auto.components.TaskPage.azureDevOps.filterTags', 'Tags')}
        values={asOptions(options.tags)}
        selected={filters.tags}
        onToggle={(key) => onChange({ ...filters, tags: toggle(filters.tags, key) })}
      />
      {!isBacklogFilterEmpty(filters) ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_BACKLOG_FILTERS)}>
          <X className="size-3" />
          {translate('auto.components.TaskPage.azureDevOps.clearFilters', 'Clear')}
        </Button>
      ) : null}
    </div>
  )
}
