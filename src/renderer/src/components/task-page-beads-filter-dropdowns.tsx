// Why: beads twin of PRFilterDropdowns — one "Filters" button opening a popover
// of Status / Priority / Type / Label / Assignee sections, with active filters
// surfacing as inline removable pills. Facets apply client-side over the
// fetched list; class strings mirror the GitHub filter UI exactly.
import React, { useMemo, useState } from 'react'
import { ChevronRight, ListFilter, X } from 'lucide-react'

import {
  MultiSelectList,
  SingleSelectList,
  type PickerOption
} from '@/components/github/PRFilterPickers'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { BeadsIssueStatus } from '../../../shared/beads-types'
import {
  hasActiveBeadsFacetFilters,
  type TaskPageBeadsFacetFilters,
  type TaskPageBeadsFacetOptions
} from './task-page-beads-issues'
import { BEADS_STATUS_ORDER, getBeadsStatusLabels } from './task-page-beads-status-visuals'

type Props = {
  filters: TaskPageBeadsFacetFilters
  options: TaskPageBeadsFacetOptions
  onChange: (next: TaskPageBeadsFacetFilters) => void
}

type BeadsFilterSectionKey = 'status' | 'priority' | 'type' | 'label' | 'assignee'

export const BEADS_PRIORITY_VALUES: readonly number[] = [0, 1, 2, 3, 4]

function multiValueSummary(values: readonly string[], pluralNoun: string): string | null {
  if (values.length === 0) {
    return null
  }
  return values.length === 1 ? values[0] : `${values.length} ${pluralNoun}`
}

function ActivePill({
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
      <span className="max-w-[160px] truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={translate(
          'auto.components.github.PRFilterDropdowns.8a2ffbf9b3',
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

export default function TaskPageBeadsFilterDropdowns({
  filters,
  options,
  onChange
}: Props): React.JSX.Element {
  const [openSection, setOpenSection] = useState<BeadsFilterSectionKey | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const statusLabels = getBeadsStatusLabels()

  const statusOpts = useMemo<PickerOption[]>(
    () => BEADS_STATUS_ORDER.map((status) => ({ key: status, primary: statusLabels[status] })),
    [statusLabels]
  )
  const priorityOpts = useMemo<PickerOption[]>(
    () =>
      BEADS_PRIORITY_VALUES.map((priority) => ({ key: String(priority), primary: `P${priority}` })),
    []
  )
  const typeOpts = useMemo<PickerOption[]>(
    () => options.types.map((type) => ({ key: type, primary: type })),
    [options.types]
  )
  const labelOpts = useMemo<PickerOption[]>(
    () => options.labels.map((label) => ({ key: label, primary: label })),
    [options.labels]
  )
  const assigneeOpts = useMemo<PickerOption[]>(
    () => options.assignees.map((assignee) => ({ key: assignee, primary: assignee })),
    [options.assignees]
  )

  const statusValue = multiValueSummary(
    filters.statuses.map((status) => statusLabels[status]),
    translate('auto.components.TaskPage.beadsFilterStatusesCount', 'statuses')
  )
  const priorityValue = multiValueSummary(
    filters.priorities.map((priority) => `P${priority}`),
    translate('auto.components.TaskPage.beadsFilterPrioritiesCount', 'priorities')
  )
  const typeValue = multiValueSummary(
    filters.types,
    translate('auto.components.TaskPage.beadsFilterTypesCount', 'types')
  )
  const labelValue = multiValueSummary(
    filters.labels,
    translate('auto.components.TaskPage.beadsFilterLabelsCount', 'labels')
  )

  const activeCount =
    (filters.statuses.length > 0 ? 1 : 0) +
    (filters.priorities.length > 0 ? 1 : 0) +
    (filters.types.length > 0 ? 1 : 0) +
    (filters.labels.length > 0 ? 1 : 0) +
    (filters.assignee ? 1 : 0)

  const sectionRows: { key: BeadsFilterSectionKey; label: string; value: string | null }[] = [
    {
      key: 'status',
      label: translate('auto.components.github.PRFilterSections.764a0b4ce1', 'Status'),
      value: statusValue
    },
    {
      key: 'priority',
      label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority'),
      value: priorityValue
    },
    {
      key: 'type',
      label: translate('auto.components.TaskPage.beadsFilterType', 'Type'),
      value: typeValue
    },
    {
      key: 'label',
      label: translate('auto.components.github.PRFilterSections.b1d9fdea08', 'Label'),
      value: labelValue
    },
    {
      key: 'assignee',
      label: translate('auto.components.github.PRFilterSections.ea3416d646', 'Assignee'),
      value: filters.assignee
    }
  ]

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover
        open={popoverOpen}
        onOpenChange={(next) => {
          setPopoverOpen(next)
          if (!next) {
            setOpenSection(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 rounded-md border-border/60 bg-background px-2.5 text-xs font-medium text-foreground shadow-xs hover:bg-muted/60',
              activeCount > 0 && 'border-border'
            )}
          >
            <ListFilter className="size-3.5" />
            {translate('auto.components.github.PRFilterDropdowns.79c54552f7', 'Filters')}
            {activeCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] font-medium text-foreground">
                {activeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {openSection === null ? (
            <div className="py-1 text-xs">
              <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {translate('auto.components.github.PRFilterSections.8177eda37e', 'Filter')}{' '}
                <span>{translate('auto.components.TaskPage.beadsFilterSubject', 'issues')}</span>
              </div>
              {sectionRows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setOpenSection(row.key)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50"
                >
                  <span>{row.label}</span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    {row.value ? <span className="max-w-[140px] truncate">{row.value}</span> : null}
                    <ChevronRight className="size-3.5" />
                  </span>
                </button>
              ))}
              {hasActiveBeadsFacetFilters(filters) ? (
                <>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    onClick={() => {
                      onChange({
                        statuses: [],
                        priorities: [],
                        types: [],
                        labels: [],
                        assignee: null
                      })
                      setPopoverOpen(false)
                    }}
                    className="w-full px-3 py-1.5 text-left text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                  >
                    {translate(
                      'auto.components.github.PRFilterSections.30ebb6ca44',
                      'Clear all filters'
                    )}
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setOpenSection(null)}
                className="flex w-full items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
              >
                <ChevronRight className="size-3 rotate-180" />
                {translate('auto.components.github.PRFilterSections.b69fa4fa20', 'Back')}
              </button>
              {openSection === 'status' ? (
                <MultiSelectList
                  options={statusOpts}
                  selected={[...filters.statuses]}
                  loading={false}
                  error={null}
                  searchPlaceholder={translate(
                    'auto.components.TaskPage.beadsFilterStatusPlaceholder',
                    'Filter statuses...'
                  )}
                  onChange={(next) =>
                    onChange({ ...filters, statuses: next as BeadsIssueStatus[] })
                  }
                />
              ) : null}
              {openSection === 'priority' ? (
                <MultiSelectList
                  options={priorityOpts}
                  selected={filters.priorities.map((priority) => String(priority))}
                  loading={false}
                  error={null}
                  searchPlaceholder={translate(
                    'auto.components.TaskPage.searchPriority',
                    'Filter priority…'
                  )}
                  onChange={(next) =>
                    onChange({ ...filters, priorities: next.map((value) => Number(value)) })
                  }
                />
              ) : null}
              {openSection === 'type' ? (
                <MultiSelectList
                  options={typeOpts}
                  selected={[...filters.types]}
                  loading={false}
                  error={null}
                  searchPlaceholder={translate(
                    'auto.components.TaskPage.beadsFilterTypePlaceholder',
                    'Filter types...'
                  )}
                  onChange={(next) => onChange({ ...filters, types: next })}
                />
              ) : null}
              {openSection === 'label' ? (
                <MultiSelectList
                  options={labelOpts}
                  selected={[...filters.labels]}
                  loading={false}
                  error={null}
                  searchPlaceholder="Filter labels..."
                  emptyText={translate(
                    'auto.components.github.PRFilterSections.de26e2eb06',
                    'No labels'
                  )}
                  onChange={(next) => onChange({ ...filters, labels: next })}
                />
              ) : null}
              {openSection === 'assignee' ? (
                <SingleSelectList
                  options={assigneeOpts}
                  activeValue={filters.assignee}
                  loading={false}
                  error={null}
                  searchPlaceholder={translate(
                    'auto.components.TaskPage.beadsFilterAssigneePlaceholder',
                    'Filter assignees...'
                  )}
                  emptyText={translate(
                    'auto.components.github.PRFilterSections.a00830d3f7',
                    'No users'
                  )}
                  onSelect={(value) => {
                    onChange({ ...filters, assignee: value })
                    setOpenSection(null)
                  }}
                />
              ) : null}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {statusValue ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.13b3ac0a84', 'Status')}
          value={statusValue}
          onClear={() => onChange({ ...filters, statuses: [] })}
        />
      ) : null}
      {priorityValue ? (
        <ActivePill
          label={translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
          value={priorityValue}
          onClear={() => onChange({ ...filters, priorities: [] })}
        />
      ) : null}
      {typeValue ? (
        <ActivePill
          label={translate('auto.components.TaskPage.beadsFilterType', 'Type')}
          value={typeValue}
          onClear={() => onChange({ ...filters, types: [] })}
        />
      ) : null}
      {labelValue ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.9d0f2eda6d', 'Label')}
          value={labelValue}
          onClear={() => onChange({ ...filters, labels: [] })}
        />
      ) : null}
      {filters.assignee ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.979be3cf6b', 'Assignee')}
          value={filters.assignee}
          onClear={() => onChange({ ...filters, assignee: null })}
        />
      ) : null}
    </div>
  )
}
